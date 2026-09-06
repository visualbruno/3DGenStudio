// Authentication for multi-user server mode.
//
// Deliberately dependency-free: password hashing and token signing both come
// from node:crypto. Adding bcrypt would mean a native build inside the Docker
// image, and jsonwebtoken would pull a dependency tree to do what ~40 lines of
// HMAC does. scrypt is a memory-hard KDF and is the right primitive here.
//
// In a single-user desktop install none of this is mounted: the Users table
// stays empty and requests are unauthenticated exactly as before. Everything
// below only activates when the process runs with GENSTUDIO_MODE=server.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
// Imported explicitly rather than taken from the global scope, matching
// server.js — the lint config does not assume Node globals.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { isUserAssetPath } from './serverMode.js';
import {
  countUsers,
  createUser,
  deleteUserById,
  findUserByLogin,
  getUserById,
  listUsers,
  normalizeUserRole,
  recordUserLogin,
  updateUser
} from './storage.js';

const scrypt = promisify(scryptCb);

// Cost parameters. N=2^15 keeps a single hash near ~100ms on a typical server,
// which is the point. They are stored inside each hash string, so raising them
// later re-hashes new passwords without invalidating existing rows.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

// scrypt's memory use is roughly 128 * N * r bytes (~32MB here); node's default
// maxmem is just under that, so it has to be raised explicitly or the call throws.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const plain = String(password ?? '');
  if (plain.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = await scrypt(String(password ?? ''), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM
    });
    // A length mismatch alone must not be distinguishable by timing.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// --- HS256 JWT -------------------------------------------------------------
// Long-lived by default: a token has to outlive a multi-minute GPU run, and it
// is the gateway (not the browser) that holds it.
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(payload, secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(body))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  // Compare as equal-length buffers, else timingSafeEqual throws.
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const AUTH_COOKIE = 'genstudio_token';

// Paths that must answer before a caller can possibly hold a token.
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/bootstrap']);

// Only these prefixes are gated. The SPA shell served out of dist/ is
// deliberately NOT gated: a browser has to be able to load the app in order to
// render the login form at all. Asset bytes ARE gated, which is why the cookie
// leg in readToken() exists.
//
// '/assets' is NOT in this list, even though asset bytes live under it, because
// so does the frontend's own bundle (dist/assets/index-<hash>.js). Gating the
// whole prefix answered 401 for the JavaScript that draws the login form — a
// deadlock, and a blank page with no way in. isUserAssetPath() knows the real
// asset subdirectories; see USER_ASSET_PREFIXES in serverMode.js. A missing one
// is not only a 404 for the desktop app -- it is also an ungated read here.
const PROTECTED_PREFIXES = ['/api', '/wiki-media'];

function isProtectedPath(pathname) {
  if (isUserAssetPath(pathname)) return true;
  return PROTECTED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Anything that mutates requires the 'user' or 'admin' role.
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  // Cookie fallback: <img src> and three.js GLTF loads cannot set headers, so
  // asset requests from the read-only browser UI authenticate this way.
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === AUTH_COOKIE) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}

export function resolveJwtSecret() {
  const secret = String(process.env.GENSTUDIO_JWT_SECRET || '');
  if (secret.length >= 16) return secret;
  // Refusing to boot is correct: a secret generated per restart silently
  // invalidates every session on each deploy, and a weak shared default is
  // worse than no auth because it looks like security.
  throw new Error(
    'GENSTUDIO_JWT_SECRET must be set to at least 16 characters when GENSTUDIO_MODE=server. ' +
    'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

// Mounts /api/auth/*, /api/users and the gate. Call BEFORE the data routes.
export function mountAuth(app, { secret, mode }) {
  if (mode !== 'server') return;

  app.post('/api/auth/login', async (req, res) => {
    try {
      const login = String(req.body?.login || '').trim();
      const password = String(req.body?.password || '');
      if (!login || !password) {
        return res.status(400).json({ error: 'login and password are required' });
      }

      const user = await findUserByLogin(login);
      // Verify even when the user is missing, so an unknown login and a wrong
      // password cost the same wall-clock time and cannot be told apart.
      const ok = await verifyPassword(password, user?.passwordHash || 'scrypt$1$1$1$AA$AA');
      if (!user || !ok || user.disabled) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      await recordUserLogin(user.id);
      const token = sign({ sub: user.id, login: user.login, role: user.role }, secret);
      res.setHeader('Set-Cookie', [
        `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${DEFAULT_TTL_SECONDS}`
      ].join('; '));
      // findUserByLogin is the one function that returns the hash; strip it
      // explicitly so it cannot reach the response.
      const safeUser = { ...user };
      delete safeUser.passwordHash;
      res.json({ token, user: safeUser });
    } catch (err) {
      console.error('Login failed:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // One-time first-admin creation, allowed only while no user exists.
  app.post('/api/auth/bootstrap', async (req, res) => {
    try {
      if (await countUsers() > 0) {
        return res.status(409).json({ error: 'Users already exist' });
      }
      const login = String(req.body?.login || '').trim();
      const password = String(req.body?.password || '');
      if (!login || !password) {
        return res.status(400).json({ error: 'login and password are required' });
      }
      const user = await createUser({
        login,
        passwordHash: await hashPassword(password),
        displayName: req.body?.displayName || login,
        role: 'admin'
      });
      res.status(201).json({ user });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Bootstrap failed' });
    }
  });

  // --- the gate ---
  app.use((req, res, next) => {
    if (!isProtectedPath(req.path) || PUBLIC_PATHS.has(req.path)) return next();

    const payload = verify(readToken(req), secret);
    if (!payload) return res.status(401).json({ error: 'Authentication required' });
    if (!READ_ONLY_METHODS.has(req.method) && normalizeUserRole(payload.role) === 'viewer') {
      return res.status(403).json({ error: 'Your role is read-only' });
    }
    req.user = { id: payload.sub, login: payload.login, role: normalizeUserRole(payload.role) };
    next();
  });

  app.get('/api/auth/me', async (req, res) => {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.json({ user });
  });

  // --- admin-only user management ---
  const requireAdmin = (req, res, next) => (
    req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator role required' })
  );

  app.get('/api/users', requireAdmin, async (req, res) => {
    res.json(await listUsers());
  });

  app.post('/api/users', requireAdmin, async (req, res) => {
    try {
      const user = await createUser({
        login: req.body?.login,
        passwordHash: await hashPassword(req.body?.password),
        displayName: req.body?.displayName,
        role: req.body?.role
      });
      res.status(201).json(user);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to create user' });
    }
  });

  app.patch('/api/users/:id', requireAdmin, async (req, res) => {
    try {
      const target = await getUserById(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });

      const updates = {};
      for (const key of ['displayName', 'role', 'avatar', 'disabled']) {
        if (req.body?.[key] !== undefined) updates[key] = req.body[key];
      }
      if (req.body?.password) updates.passwordHash = await hashPassword(req.body.password);

      // Guard against locking everyone out: the last enabled admin may not be
      // demoted or disabled.
      const losingAdmin = (updates.role !== undefined && normalizeUserRole(updates.role) !== 'admin')
        || updates.disabled === true;
      if (target.role === 'admin' && losingAdmin) {
        const admins = (await listUsers()).filter(user => user.role === 'admin' && !user.disabled);
        if (admins.length <= 1) {
          return res.status(409).json({ error: 'Cannot remove the last administrator' });
        }
      }

      res.json(await updateUser(req.params.id, updates));
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to update user' });
    }
  });

  app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      const admins = (await listUsers()).filter(user => user.role === 'admin' && !user.disabled);
      if (admins.length <= 1) {
        return res.status(409).json({ error: 'Cannot delete the last administrator' });
      }
    }
    res.json({ deleted: await deleteUserById(req.params.id) });
  });
}

// Seed the first admin from the environment, so a container comes up usable.
//
// Throws rather than warning when seeding was asked for and could not be done.
// A server with no account is unusable, and the only symptom the user ever sees
// is "Invalid credentials" on a login for a user that was never created — the
// real reason sits in the container log, which nobody reads while a healthy
// container is refusing to let them in.
export async function seedAdminFromEnv() {
  const login = String(process.env.GENSTUDIO_ADMIN_LOGIN || '').trim();
  const password = String(process.env.GENSTUDIO_ADMIN_PASSWORD || '');

  // Nothing requested: a server whose users were created some other way.
  if (!login && !password) return;

  if (!login || !password) {
    throw new Error('GENSTUDIO_ADMIN_LOGIN and GENSTUDIO_ADMIN_PASSWORD must both be set');
  }

  // Already seeded — the usual case on every restart after the first.
  if (await countUsers() > 0) return;

  await createUser({
    login,
    passwordHash: await hashPassword(password),
    displayName: login,
    role: 'admin'
  });
  console.log(`👤 Seeded initial administrator "${login}" from the environment`);
}
