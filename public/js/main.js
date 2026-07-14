// main.js - front-end interactions for posting, commenting, liking
document.addEventListener('DOMContentLoaded', function () {
  // Post form
  const postForm = document.getElementById('post-form');
  if (postForm) {
    postForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = document.getElementById('post-body').value;
      const is_anonymous = postForm.querySelector('input[name="is_anonymous"]').checked;
      const msg = document.getElementById('post-msg');
      msg.textContent = '';
      try {
        const res = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, is_anonymous })
        });
        const j = await res.json();
        if (res.ok) {
          msg.textContent = '发布成功，正在刷新...';
          setTimeout(() => location.reload(), 800);
        } else {
          msg.textContent = j.error || '发布失败';
        }
      } catch (err) {
        msg.textContent = '网络错误';
      }
    });
  }

  // Comment form
  const commentForm = document.getElementById('comment-form');
  if (commentForm) {
    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = document.getElementById('comment-body').value;
      const msg = document.getElementById('comment-msg');
      msg.textContent = '';
      try {
        const res = await fetch(`/api/posts/${window.APP.postId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body })
        });
        const j = await res.json();
        if (res.ok) {
          msg.textContent = '评论成功，正在刷新...';
          setTimeout(() => location.reload(), 600);
        } else {
          msg.textContent = j.error || '评论失败';
        }
      } catch (err) {
        msg.textContent = '网络错误';
      }
    });
  }

  // Like button
  const likeBtn = document.getElementById('like-btn');
  if (likeBtn) {
    likeBtn.addEventListener('click', async (e) => {
      const postId = likeBtn.getAttribute('data-post-id');
      try {
        const res = await fetch(`/api/posts/${postId}/like`, { method: 'POST' });
        const j = await res.json();
        if (res.ok) {
          const likeCountEl = document.getElementById('like-count');
          if (j.liked) {
            likeBtn.textContent = '取消点赞';
            // increment
            likeCountEl.textContent = '👍 ' + (parseInt(likeCountEl.textContent.replace('👍','').trim()) + 1);
          } else {
            likeBtn.textContent = '点赞';
            likeCountEl.textContent = '👍 ' + (Math.max(0, parseInt(likeCountEl.textContent.replace('👍','').trim()) - 1));
          }
        }
      } catch (err) {
        console.error(err);
      }
    });
  }
});
