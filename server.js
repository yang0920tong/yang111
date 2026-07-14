const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, 'db.sqlite');
const PORT = process.env.PORT || 3000;

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

let dbClient = null;
let isPostgres = false;

async function initDbClient() {
  if (process.env.DATABASE_URL) {
    // Use Postgres
    isPostgres = true;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    // expose simple wrapper
    dbClient = {
      query: (text, params) => pool.query(text, params),
      get: async (text, params) => {
        const r = await pool.query(text, params);
        return r.rows[0];
      },
      all: async (text, params) => {
        const r = await pool.query(text, params);
        return r.rows;
      },
      run: async (text, params) => {
        return pool.query(text, params);
      }
    };

    // Run migrations / create tables
    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        body TEXT NOT NULL,
        is_anonymous BOOLEAN DEFAULT TRUE,
        anon_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        parent_comment_id INTEGER,
        anon_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        anon_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (post_id, anon_id)
      );
    `);

  } else {
    // Use SQLite
    const db = new sqlite3.Database(DB_PATH);
    dbClient = {
      query: (text, params) => new Promise((resolve, reject) => db.all(text, params || [], (err, rows) => err ? reject(err) : resolve({ rows }))),
      get: (text, params) => new Promise((resolve, reject) => db.get(text, params || [], (err, row) => err ? reject(err) : resolve(row))),
      all: (text, params) => new Promise((resolve, reject) => db.all(text, params || [], (err, rows) => err ? reject(err) : resolve(rows))),
      run: (text, params) => new Promise((resolve, reject) => db.run(text, params || [], function (err) { if (err) return reject(err); resolve(this); }))
    };

    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        is_anonymous INTEGER DEFAULT 1,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        parent_comment_id INTEGER,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(post_id) REFERENCES posts(id)
      );
    `);

    await dbClient.run(`
      CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, anon_id)
      );
    `);
  }
}

// initialize DB client
initDbClient().catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});

// Middleware: ensure anon_id cookie
app.use((req, res, next) => {
  if (!req.cookies.anon_id) {
    const id = uuidv4();
    res.cookie('anon_id', id, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 365 });
    req.anon_id = id;
  } else {
    req.anon_id = req.cookies.anon_id;
  }
  next();
});

// Helpers to query counts
async function listPosts() {
  if (isPostgres) {
    const q = `
      SELECT p.*, COALESCE(l.count,0) as like_count, COALESCE(c.count,0) as comment_count
      FROM posts p
      LEFT JOIN (SELECT post_id, COUNT(*) as count FROM likes GROUP BY post_id) l ON l.post_id = p.id
      LEFT JOIN (SELECT post_id, COUNT(*) as count FROM comments GROUP BY post_id) c ON c.post_id = p.id
      ORDER BY p.created_at DESC
      LIMIT 100
    `;
    return await dbClient.all(q, []);
  } else {
    const q = `
      SELECT p.*, 
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
      FROM posts p
      ORDER BY p.created_at DESC
      LIMIT 100
    `;
    return await dbClient.all(q, []);
  }
}

app.get('/', async (req, res) => {
  try {
    const posts = await listPosts();
    res.render('index', { posts });
  } catch (err) {
    console.error(err);
    res.status(500).send('DB error');
  }
});

app.get('/post/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const post = await dbClient.get('SELECT * FROM posts WHERE id = $1', isPostgres ? [id] : [id]);
    if (!post) return res.status(404).send('Not found');
    const comments = await dbClient.all('SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC', isPostgres ? [id] : [id]);
    const likeRow = await dbClient.get('SELECT COUNT(*) as cnt FROM likes WHERE post_id = $1', isPostgres ? [id] : [id]);
    const likes = likeRow ? (isPostgres ? likeRow.cnt : likeRow.cnt) : 0;
    // check whether current anon_id liked this post
    const likedRow = await dbClient.get('SELECT id FROM likes WHERE post_id = $1 AND anon_id = $2', isPostgres ? [id, req.anon_id] : [id, req.anon_id]);
    const liked = !!likedRow;
    res.render('post', { post, comments, likes, liked, anon_id: req.anon_id });
  } catch (err) {
    console.error(err);
    res.status(500).send('DB error');
  }
});

// API: create post
app.post('/api/posts', async (req, res) => {
  const { body, is_anonymous } = req.body;
  if (!body || body.trim().length === 0) return res.status(400).json({ error: 'Body required' });
  try {
    if (isPostgres) {
      const r = await dbClient.run('INSERT INTO posts (body, is_anonymous, anon_id) VALUES ($1, $2, $3) RETURNING id', [body, is_anonymous ? true : false, req.anon_id]);
      const id = r.rows ? r.rows[0].id : null;
      return res.json({ id });
    } else {
      const stmt = await dbClient.run('INSERT INTO posts (body, is_anonymous, anon_id) VALUES (?, ?, ?)', [body, is_anonymous ? 1 : 0, req.anon_id]);
      return res.json({ id: stmt.lastID });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// API: add comment
app.post('/api/posts/:id/comments', async (req, res) => {
  const postId = req.params.id;
  const { body, parent_comment_id } = req.body;
  if (!body || body.trim().length === 0) return res.status(400).json({ error: 'Body required' });
  try {
    if (isPostgres) {
      const r = await dbClient.run('INSERT INTO comments (post_id, body, parent_comment_id, anon_id) VALUES ($1, $2, $3, $4) RETURNING id', [postId, body, parent_comment_id || null, req.anon_id]);
      const id = r.rows ? r.rows[0].id : null;
      return res.json({ id });
    } else {
      const stmt = await dbClient.run('INSERT INTO comments (post_id, body, parent_comment_id, anon_id) VALUES (?, ?, ?, ?)', [postId, body, parent_comment_id || null, req.anon_id]);
      return res.json({ id: stmt.lastID });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// API: like / unlike (toggle)
app.post('/api/posts/:id/like', async (req, res) => {
  const postId = req.params.id;
  const anonId = req.anon_id;
  try {
    if (isPostgres) {
      try {
        await dbClient.run('INSERT INTO likes (post_id, anon_id) VALUES ($1, $2)', [postId, anonId]);
        return res.json({ liked: true });
      } catch (err) {
        // unique violation -> delete
        // Postgres unique violation code is 23505
        if (err && err.code === '23505') {
          await dbClient.run('DELETE FROM likes WHERE post_id = $1 AND anon_id = $2', [postId, anonId]);
          return res.json({ liked: false });
        }
        throw err;
      }
    } else {
      try {
        await dbClient.run('INSERT INTO likes (post_id, anon_id) VALUES (?, ?)', [postId, anonId]);
        return res.json({ liked: true });
      } catch (err) {
        // assume unique constraint -> delete
        await dbClient.run('DELETE FROM likes WHERE post_id = ? AND anon_id = ?', [postId, anonId]);
        return res.json({ liked: false });
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
