const crypto = require('crypto');

function nowMs() {
  return Date.now();
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
}

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function parseCorsOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (raw === '*') return true;
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

function normalizeOriginRule(rule) {
  const raw = typeof rule === 'string' ? rule.trim() : '';
  if (!raw) return null;
  // allow host-only rules (e.g. "example.com" or "example.com:3000")
  // and origin rules (e.g. "https://example.com")
  return raw.replace(/\/+$/g, '').toLowerCase();
}

function parseHostPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return { host: '', port: '' };
  const idx = raw.lastIndexOf(':');
  if (idx > -1 && raw.slice(idx + 1).match(/^\d+$/)) {
    return { host: raw.slice(0, idx).toLowerCase(), port: raw.slice(idx + 1) };
  }
  return { host: raw.toLowerCase(), port: '' };
}

function originIsAllowed(allowed, origin) {
  if (!allowed) return true;
  if (allowed === true) return true;
  const list = (Array.isArray(allowed) ? allowed : [allowed]).map(normalizeOriginRule).filter(Boolean);
  const originRaw = String(origin || '').trim();
  if (!originRaw) return false;

  const originNormalized = originRaw.replace(/\/+$/g, '').toLowerCase();
  let originUrl = null;
  try {
    originUrl = new URL(originRaw);
  } catch {
    // ignore
  }

  for (const rule of list) {
    if (rule === originNormalized) return true;

    // wildcard subdomain rule: "*.netlify.app"
    if (rule.startsWith('*.') && originUrl?.hostname) {
      const suffix = rule.slice(1); // ".netlify.app"
      if (originUrl.hostname.toLowerCase().endsWith(suffix)) return true;
      continue;
    }

    // compare as host-only
    if (!rule.includes('://') && originUrl?.hostname) {
      const { host, port } = parseHostPort(rule);
      const originPort = originUrl.port || '';
      if (host && host === originUrl.hostname.toLowerCase() && (!port || port === originPort)) return true;
      continue;
    }

    // compare as full origin URL (protocol + host + optional port)
    if (rule.includes('://')) {
      try {
        const ruleUrl = new URL(rule);
        if (
          originUrl &&
          ruleUrl.protocol === originUrl.protocol &&
          ruleUrl.hostname.toLowerCase() === originUrl.hostname.toLowerCase() &&
          (ruleUrl.port || '') === (originUrl.port || '')
        ) {
          return true;
        }
      } catch {
        // ignore invalid rule
      }
    }
  }

  return false;
}

module.exports = {
  nowMs,
  sanitizeText,
  generateToken,
  generateRoomCode,
  parseCorsOrigin,
  originIsAllowed,
};
