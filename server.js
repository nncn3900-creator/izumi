const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const DB_PATH = path.join(__dirname, 'db.json');
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const requestLog = new Map();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  const now = Date.now();
  const key = req.ip || 'unknown';
  const recent = (requestLog.get(key) || []).filter(time => now - time < 60000);
  if(recent.length >= 120) return res.status(429).json({ error: 'too_many_requests' });
  recent.push(now);
  requestLog.set(key, recent);
  next();
});

function readDB(){
  try{
    if(!fs.existsSync(DB_PATH)) return { state: {} };
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{"state":{}}');
  }catch(e){
    console.error('readDB error:', e.message);
    return { state: {} };
  }
}
function writeDB(obj){
  try{
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tempPath, DB_PATH);
    console.log('State persisted to db.json');
    return true;
  }catch(e){
    console.error('writeDB error:', e.message);
    return false;
  }
}

function mergeByKey(existing, incoming, key){
  const merged = Array.isArray(existing) ? existing.slice() : [];
  const indexes = new Map(merged.map((item, index) => [item && item[key], index]));
  (Array.isArray(incoming) ? incoming : []).forEach(item => {
    if(!item || item[key] === undefined || item[key] === null) return;
    const index = indexes.get(item[key]);
    if(index === undefined){
      indexes.set(item[key], merged.length);
      merged.push(item);
    } else {
      merged[index] = { ...merged[index], ...item };
    }
  });
  return merged;
}

function mergeState(current, incoming){
  const previous = current || {};
  const next = incoming || {};
  const deletedPostIds = Array.from(new Set([
    ...(previous.deletedPostIds || []),
    ...(next.deletedPostIds || [])
  ].map(id => Number(id)).filter(Number.isFinite)));
  return {
    ...previous,
    ...next,
    users: mergeByKey(previous.users, next.users, 'id'),
    posts: mergeByKey(previous.posts, next.posts, 'id').filter(post => !deletedPostIds.includes(post.id)),
    deletedPostIds,
    subs: mergeByKey(previous.subs, next.subs, 'name'),
    saved: Array.from(new Set([...(previous.saved || []), ...(next.saved || [])])),
    activeSubs: Array.from(new Set([...(previous.activeSubs || []), ...(next.activeSubs || [])])),
    reports: mergeByKey(previous.reports, next.reports, 'date'),
    notifications: mergeByKey(previous.notifications, next.notifications, 'id')
  };
}

// API: get whole state
app.get('/api/state', (req, res)=>{
  try{
    const db = readDB();
    res.json(db);
  }catch(e){
    console.error('GET /api/state error:', e.message);
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
});

function deletePostHandler(req, res){
  try{
    const body = req.body || {};
    const rawPostId = body.postId ?? req.params.id ?? req.query.id;
    const postId = Number(rawPostId);
    const userId = Number(body.userId ?? req.query.userId ?? body.user_id);
    const username = body.username ?? req.query.username;
    const passwordHash = body.passwordHash ?? body.password ?? req.query.passwordHash;

    if(!postId || !userId || !passwordHash) {
      return res.status(400).json({ error: 'missing_credentials' });
    }

    const db = readDB();
    const current = db.state || {};
    const user = (current.users || []).find(item => {
      const idMatches = Number(item.id) === Number(userId);
      const passMatches = item.pass === passwordHash;
      const nameMatches = !username || item.name === username;
      return idMatches && passMatches && nameMatches;
    });

    if(!user) return res.status(403).json({ error: 'invalid_user' });
    const post = (current.posts || []).find(item => Number(item.id) === Number(postId));
    if(!post) return res.status(404).json({ error: 'post_not_found' });
    if(post.authorId !== user.id && post.author !== user.name) return res.status(403).json({ error: 'not_post_author' });

    const deletedPostIds = Array.from(new Set([...(current.deletedPostIds || []), Number(postId)]));
    const nextState = {
      ...current,
      deletedPostIds,
      posts: (current.posts || []).filter(item => Number(item.id) !== Number(postId)),
      saved: (current.saved || []).filter(id => Number(id) !== Number(postId)),
      reports: (current.reports || []).filter(report => Number(report.postId) !== Number(postId))
    };

    const persisted = writeDB({ state: nextState, updatedAt: Date.now() });
    if(!persisted) return res.status(500).json({ error: 'write_failed' });

    const verified = readDB();
    if((verified.state.posts || []).some(item => Number(item.id) === Number(postId))) {
      return res.status(500).json({ error: 'delete_not_persisted' });
    }

    res.json({ ok: true, deletedPostId: Number(postId) });
  }catch(error){
    console.error('DELETE /api/post/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.delete('/api/post/:id', deletePostHandler);
app.post('/api/post/delete', deletePostHandler);

// API: save entire state
app.post('/api/state', (req, res)=>{
  try{
    const body = req.body || {};
    if(!body.state) return res.status(400).json({ error: 'missing state' });
    const current = readDB();
    const mergedState = mergeState(current.state, body.state);
    const ok = writeDB({ state: mergedState, updatedAt: Date.now() });
    if(!ok) return res.status(500).json({ error: 'write_failed' });
    res.json({ ok: true });
  }catch(e){
    console.error('POST /api/state error:', e.message);
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
});

app.post('/api/account/delete', (req, res)=>{
  try{
    const { userId, username, passwordHash } = req.body || {};
    if(!userId || !passwordHash) return res.status(400).json({ error: 'missing_credentials' });
    const db = readDB();
    const current = db.state || {};
    const matchesUser = user => user.id === userId && user.pass === passwordHash && (!username || user.name === username);
    const deletedUser = (current.users || []).find(matchesUser);
    if(!deletedUser) return res.status(404).json({ error: 'user_not_found' });
    const deletedName = deletedUser.name;
    const nextState = {
      ...current,
      users: (current.users || []).filter(user => !matchesUser(user)),
      posts: (current.posts || []).filter(post => post.authorId !== deletedUser.id && post.author !== deletedName),
      subs: (current.subs || []).filter(sub => sub.owner !== deletedName),
      activeSubs: (current.activeSubs || []).filter(name => (current.subs || []).some(sub => sub.name === name && sub.owner !== deletedName)),
      reports: (current.reports || []).filter(report => report.reportedBy !== deletedName)
    };
    const ok = writeDB({ state: nextState, updatedAt: Date.now() });
    if(!ok) return res.status(500).json({ error: 'write_failed' });
    res.json({ ok: true });
  }catch(e){
    console.error('POST /api/account/delete error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/db.json', (req, res)=>res.status(404).json({ error: 'not_found' }));

// serve static files (frontend)
app.use(express.static(__dirname));

// serve izumi.html as root
app.get('/', (req, res)=>{
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'izumi.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log(`izumi server running on http://localhost:${PORT}`);
});
