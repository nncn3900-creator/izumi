const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const DB_PATH = path.join(__dirname, 'db.json');
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// If izumi is deployed behind a reverse proxy (Render, Nginx, etc.), this makes
// req.ip reflect the real client IP instead of the proxy's IP, so per-IP rate
// limiting actually works per visitor instead of lumping everyone together.
app.set('trust proxy', 1);

// Restrict CORS to a known origin when ALLOWED_ORIGIN/SITE_URL is configured.
// Defaults to '*' (previous behavior) so nothing breaks out of the box, but you
// should set ALLOWED_ORIGIN in production to stop other websites from calling
// this API on behalf of your visitors.
const allowedOrigin = process.env.ALLOWED_ORIGIN || process.env.SITE_URL || null;
if(!allowedOrigin) console.warn('[izumi] ALLOWED_ORIGIN not set - API accepts requests from any origin. Set ALLOWED_ORIGIN in production.');
app.use(cors({ origin: allowedOrigin || true }));
app.use(express.json({ limit: '50mb' }));

io.on('connection', socket => {
  socket.on('join-feed', () => socket.join('feed'));
});

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

function mergePostRecords(existing, incoming){
  const merged = mergeByKey(existing, incoming, 'id');
  const existingById = new Map((Array.isArray(existing) ? existing : []).map(post => [post && post.id, post]));
  const incomingById = new Map((Array.isArray(incoming) ? incoming : []).map(post => [post && post.id, post]));
  return merged.map(post => {
    const existingPost = existingById.get(post && post.id);
    const incomingPost = incomingById.get(post && post.id);
    if(!incomingPost || !Array.isArray(incomingPost.comments)) return post;
    return {
      ...post,
      comments: mergeByKey(existingPost && existingPost.comments, incomingPost.comments, 'id')
    };
  });
}

function normalizeSubName(value){
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

// Mirrors the client's normalizeUsername() so username lookups behave
// identically on both sides (Turkish-aware lowercasing, trimmed).
function normalizeUsername(value){
  return String(value || '').trim().toLocaleLowerCase('tr-TR');
}

const SUB_NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

function normalizeSubs(subs){
  const unique = new Map();
  (Array.isArray(subs) ? subs : []).forEach(sub => {
    if(!sub) return;
    const name = normalizeSubName(sub.name);
    // Reject malformed sub names (e.g. containing quotes/HTML) coming from
    // direct API calls that bypass the UI's own validation.
    if(!name || !SUB_NAME_RE.test(name) || unique.has(name)) return;
    unique.set(name, { ...sub, name, desc: String(sub.desc || '').slice(0, 500) });
  });
  return Array.from(unique.values());
}

// Never let a client push a password field through the generic state-sync
// endpoint. Passwords are only ever set via /api/auth/register and upgraded
// via /api/auth/login - this endpoint must not be able to plant or overwrite one.
function stripPasswords(users){
  return (Array.isArray(users) ? users : []).map(user => {
    if(!user || typeof user !== 'object') return user;
    const { pass, ...rest } = user;
    return rest;
  });
}

function mergeState(current, incoming){
  const previous = current || {};
  const next = incoming || {};
  const deletedPostIds = Array.from(new Set([
    ...(previous.deletedPostIds || []),
    ...(next.deletedPostIds || [])
  ].map(id => Number(id)).filter(Number.isFinite)));
  const reactivatedSubNames = new Set(
    (Array.isArray(next.subs) ? next.subs : []).map(sub => normalizeSubName(sub && sub.name)).filter(Boolean)
  );
  const deletedSubNames = Array.from(new Set([
    ...(previous.deletedSubNames || []),
    ...(next.deletedSubNames || [])
  ].map(normalizeSubName).filter(Boolean))).filter(name => !reactivatedSubNames.has(name));
  const isDeletedSub = sub => deletedSubNames.includes(normalizeSubName(sub && sub.name));
  const isDeletedSubName = name => deletedSubNames.includes(normalizeSubName(name));
  const incomingUsers = stripPasswords(next.users);
  const mergedUsersRaw = mergeByKey(previous.users, incomingUsers, 'id');
  // Re-attach each existing user's real password hash by id, since incomingUsers
  // never carries one (stripPasswords removes it) - this keeps profile-field
  // merges (bio/avatar/settings) working without ever letting the client set `pass`.
  const previousPassById = new Map((Array.isArray(previous.users) ? previous.users : []).map(u => [u && u.id, u && u.pass]));
  return {
    ...previous,
    ...next,
    posts: mergePostRecords(previous.posts, next.posts).filter(post => !deletedPostIds.includes(post.id)),
    deletedPostIds,
    deletedSubNames,
    subs: normalizeSubs(mergeByKey(previous.subs, next.subs, 'name')).filter(sub => !isDeletedSub(sub)),
    saved: Array.from(new Set([...(previous.saved || []), ...(next.saved || [])])),
    activeSubs: Array.from(new Set([...(previous.activeSubs || []), ...(next.activeSubs || [])])).filter(name => !isDeletedSubName(name)),
    users: mergedUsersRaw.map(user => ({
      ...user,
      pass: previousPassById.has(user.id) ? previousPassById.get(user.id) : user.pass,
      subscriptions: (user.subscriptions || []).map(normalizeSubName).filter(name => !isDeletedSubName(name))
    })),
    reports: mergeByKey(previous.reports, next.reports, 'date'),
    notifications: normalizeNotifications(mergeByKey(previous.notifications, next.notifications, 'id'))
  };
}

function normalizeNotifications(notifications){
  const unique = new Map();
  (Array.isArray(notifications) ? notifications : []).forEach(item => {
    const key = [item.username, item.type, Number(item.postId) || 0, item.message].join('|');
    const previous = unique.get(key);
    if(!previous || Number(item.createdAt) > Number(previous.createdAt)) unique.set(key, item);
  });
  return Array.from(unique.values()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 200);
}

function sanitizeStateForClient(state){
  if(!state) return state;
  // Password hashes must never leave the server, under any circumstance.
  return { ...state, users: stripPasswords(state.users) };
}

// ---------------------------------------------------------------------------
// Auth: real server-side sessions instead of trusting a client-sent hash.
// ---------------------------------------------------------------------------

const STRONG_PASSWORD_RE = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> { userId, expires }
const loginAttempts = new Map(); // "ip:username" -> [timestamps]

function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(token){
  if(!token) return null;
  const session = sessions.get(token);
  if(!session) return null;
  if(session.expires < Date.now()){ sessions.delete(token); return null; }
  return session;
}
// Periodically drop expired sessions so this Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for(const [token, session] of sessions){ if(session.expires < now) sessions.delete(token); }
}, 60 * 60 * 1000).unref();

function tooManyLoginAttempts(key){
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if(attempts.length >= 8) { loginAttempts.set(key, attempts); return true; }
  attempts.push(now);
  loginAttempts.set(key, attempts);
  return false;
}

function requireAuth(req, res, next){
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const session = getSession(token);
  if(!session) return res.status(401).json({ error: 'unauthorized' });
  const db = readDB();
  const user = (db.state.users || []).find(u => Number(u.id) === Number(session.userId));
  if(!user){ sessions.delete(token); return res.status(401).json({ error: 'unauthorized' }); }
  req.authUser = { id: user.id, name: user.name };
  req.authToken = token;
  next();
}

app.post('/api/auth/register', async (req, res) => {
  try{
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    if(!name) return res.status(400).json({ error: 'missing_username' });
    if(name.length > 32) return res.status(400).json({ error: 'username_too_long' });
    if(!STRONG_PASSWORD_RE.test(String(password || ''))) return res.status(400).json({ error: 'weak_password' });

    const db = readDB();
    const current = db.state || {};
    const normalized = normalizeUsername(name);
    const taken = (current.users || []).some(u => normalizeUsername(u.name) === normalized);
    if(taken) return res.status(409).json({ error: 'username_taken' });

    const passHash = await bcrypt.hash(String(password), 10);
    const user = { id: Date.now(), createdAt: Date.now(), name, pass: passHash, bio: '', karma: 1, votes: {}, subscriptions: [], following: [], settings: {} };
    const nextUsers = [...(current.users || []), user];
    const ok = writeDB({ state: { ...current, users: nextUsers }, updatedAt: Date.now() });
    if(!ok) return res.status(500).json({ error: 'write_failed' });

    const token = createSession(user.id);
    const { pass, ...publicUser } = user;
    io.to('feed').emit('state-updated', { updatedAt: Date.now() });
    res.json({ ok: true, token, user: publicUser });
  }catch(e){
    console.error('POST /api/auth/register error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try{
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    const pass = String(password || '');
    if(!name || !pass) return res.status(400).json({ error: 'missing_credentials' });

    const normalized = normalizeUsername(name);
    const limitKey = `${req.ip}:${normalized}`;
    if(tooManyLoginAttempts(limitKey)) return res.status(429).json({ error: 'too_many_attempts' });

    const db = readDB();
    const current = db.state || {};
    const users = current.users || [];
    const idx = users.findIndex(u => normalizeUsername(u.name) === normalized);
    if(idx === -1) return res.status(404).json({ error: 'user_not_found' });

    const user = users[idx];
    let valid = false;
    if(typeof user.pass === 'string' && user.pass.startsWith('$2')){
      // Already migrated to bcrypt.
      valid = await bcrypt.compare(pass, user.pass);
    } else if(typeof user.pass === 'string' && /^[0-9a-f]{64}$/i.test(user.pass)){
      // Legacy account from before this fix: password was hashed client-side
      // with unsalted SHA-256. Verify against that once, then transparently
      // upgrade to a salted bcrypt hash so it never has to be checked this way again.
      const legacyHash = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
      valid = legacyHash === user.pass;
      if(valid) users[idx] = { ...user, pass: await bcrypt.hash(pass, 10) };
    } else if(typeof user.pass === 'string'){
      // Legacy plaintext safety net (should not normally occur).
      valid = pass === user.pass;
      if(valid) users[idx] = { ...user, pass: await bcrypt.hash(pass, 10) };
    }

    if(!valid) return res.status(401).json({ error: 'invalid_credentials' });
    writeDB({ state: { ...current, users }, updatedAt: Date.now() });

    const finalUser = users[idx];
    const token = createSession(finalUser.id);
    const { pass: _p, ...publicUser } = finalUser;
    res.json({ ok: true, token, user: publicUser });
  }catch(e){
    console.error('POST /api/auth/login error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.authToken);
  res.json({ ok: true });
});

// API: get whole state (password hashes are always stripped before leaving the server)
app.get('/api/state', (req, res)=>{
  try{
    const db = readDB();
    res.json({ ...db, state: sanitizeStateForClient(db.state) });
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
    if(!postId) return res.status(400).json({ error: 'missing_post_id' });

    const db = readDB();
    const current = db.state || {};
    const post = (current.posts || []).find(item => Number(item.id) === Number(postId));
    if(!post) return res.status(404).json({ error: 'post_not_found' });

    // req.authUser is set by requireAuth from a verified session token - no
    // client-supplied password/hash is trusted here anymore.
    const user = req.authUser;
    const isAuthor = (post.authorId && Number(post.authorId) === Number(user.id)) || (!post.authorId && post.author === user.name);
    const sub = (current.subs || []).find(s => s.name === post.sub);
    const isSubOwner = !!(sub && sub.owner === user.name);
    const anyoneCanDelete = !!(sub && sub.deletePermission === 'anyone');
    if(!isAuthor && !isSubOwner && !anyoneCanDelete) return res.status(403).json({ error: 'not_authorized' });

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

    io.to('feed').emit('state-updated', { updatedAt: Date.now() });
    res.json({ ok: true, deletedPostId: Number(postId) });
  }catch(error){
    console.error('DELETE /api/post/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.delete('/api/post/:id', requireAuth, deletePostHandler);
app.post('/api/post/delete', requireAuth, deletePostHandler);

// API: save entire state
app.post('/api/state', (req, res)=>{
  try{
    const body = req.body || {};
    if(!body.state) return res.status(400).json({ error: 'missing state' });
    const current = readDB();
    const incoming = { ...body.state };
    delete incoming.user;
    delete incoming.language;
    delete incoming.theme;
    delete incoming.feedLimit;
    delete incoming.sortMode;
    delete incoming.feedMode;
    delete incoming.saved;
    const mergedState = mergeState(current.state, incoming);
    const ok = writeDB({ state: mergedState, updatedAt: Date.now() });
    if(!ok) return res.status(500).json({ error: 'write_failed' });
    io.to('feed').emit('state-updated', { updatedAt: Date.now() });
    res.json({ ok: true });
  }catch(e){
    console.error('POST /api/state error:', e.message);
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
});

app.post('/api/account/delete', requireAuth, (req, res)=>{
  try{
    const db = readDB();
    const current = db.state || {};
    const userId = req.authUser.id;
    const deletedUser = (current.users || []).find(u => Number(u.id) === Number(userId));
    if(!deletedUser) return res.status(404).json({ error: 'user_not_found' });
    const deletedName = deletedUser.name;
    const nextState = {
      ...current,
      users: (current.users || []).filter(u => Number(u.id) !== Number(userId)),
      posts: (current.posts || []).filter(post => post.authorId !== deletedUser.id && post.author !== deletedName),
      subs: (current.subs || []).filter(sub => sub.owner !== deletedName),
      activeSubs: (current.activeSubs || []).filter(name => (current.subs || []).some(sub => sub.name === name && sub.owner !== deletedName)),
      reports: (current.reports || []).filter(report => report.reportedBy !== deletedName)
    };
    const ok = writeDB({ state: nextState, updatedAt: Date.now() });
    if(!ok) return res.status(500).json({ error: 'write_failed' });
    sessions.delete(req.authToken);
    io.to('feed').emit('state-updated', { updatedAt: Date.now() });
    res.json({ ok: true });
  }catch(e){
    console.error('POST /api/account/delete error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((error, req, res, next) => {
  if(error && error.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'Gönderilen veri çok büyük.' });
  if(error instanceof SyntaxError && error.status === 400 && error.body) return res.status(400).json({ error: 'invalid_json', message: 'Geçersiz JSON verisi.' });
  next(error);
});

function getPublicBaseUrl(req){
  const configuredUrl = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL;
  const baseUrl = configuredUrl || `${req.protocol}://${req.get('host')}`;
  return baseUrl.replace(/\/$/, '');
}

app.get('/sitemap.xml', (req, res)=>{
  const baseUrl = getPublicBaseUrl(req);
  const lastModified = new Date(readDB().updatedAt || Date.now()).toISOString();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastModified}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
  res.type('application/xml').send(sitemap);
});

app.get('/robots.txt', (req, res)=>{
  const baseUrl = getPublicBaseUrl(req);
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /db.json\nSitemap: ${baseUrl}/sitemap.xml\n`);
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
httpServer.listen(PORT, ()=>{
  console.log(`izumi server running on http://localhost:${PORT}`);
});
