const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'db.sqlite');
const PORT = process.env.PORT || 3000;

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// Init DB
const db = new sqlite3.Database(DB_PATH);

function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        is_anonymous INTEGER DEFAULT 1,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        parent_comment_id INTEGER,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(post_id) REFERENCES posts(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        anon_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, anon_id),
        FOREIGN KEY(post_id) REFERENCES posts(id)
      )
    `);
  });
}

initDb();

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

// Routes
app.get('/', (req, res) => {
  const q = `SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as like_count,
                     (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
               FROM posts p
               ORDER BY p.created_at DESC
               LIMIT 100`;
  db.all(q, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.render('index', { posts: rows });
  });
});

app.get('/post/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM posts WHERE id = ?', [id], (err, post) => {
    if (err) return res.status(500).send('DB error');
    if (!post) return res.status(404).send('Not found');
    db.all('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC', [id], (err2, comments) => {
      if (err2) return res.status(500).send('DB error');
      db.get('SELECT COUNT(*) as cnt FROM likes WHERE post_id = ?', [id], (err3, likeRow) => {
        if (err3) return res.status(500).send('DB error');
        const liked = !!likeRow && likeRow.cnt > 0;
        res.render('post', { post, comments, likes: likeRow ? likeRow.cnt : 0, anon_id: req.anon_id });
      });
    });
  });
});

// API: create post
app.post('/api/posts', (req, res) => {
  const { body, is_anonymous } = req.body;
  if (!body || body.trim().length === 0) return res.status(400).json({ error: 'Body required' });
  const stmt = db.prepare('INSERT INTO posts (body, is_anonymous, anon_id) VALUES (?, ?, ?)');
  stmt.run(body, is_anonymous ? 1 : 0, req.anon_id, function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ id: this.lastID });
  });
});

// API: add comment
app.post('/api/posts/:id/comments', (req, res) => {
  const postId = req.params.id;
  const { body, parent_comment_id } = req.body;
  if (!body || body.trim().length === 0) return res.status(400).json({ error: 'Body required' });
  const stmt = db.prepare('INSERT INTO comments (post_id, body, parent_comment_id, anon_id) VALUES (?, ?, ?, ?)');
  stmt.run(postId, body, parent_comment_id || null, req.anon_id, function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ id: this.lastID });
  });
});

// API: like / unlike (toggle)
app.post('/api/posts/:id/like', (req, res) => {
  const postId = req.params.id;
  const anonId = req.anon_id;
  // try insert, if fails delete (toggle)
  const insert = 'INSERT INTO likes (post_id, anon_id) VALUES (?, ?)';
  db.run(insert, [postId, anonId], function (err) {
    if (!err) {
      return res.json({ liked: true });
    }
    // if unique constraint violated, remove existing
    db.run('DELETE FROM likes WHERE post_id = ? AND anon_id = ?', [postId, anonId], function (delErr) {
      if (delErr) return res.status(500).json({ error: 'DB error' });
      return res.json({ liked: false });
    });
  });
});

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
