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

function originIsAllowed(allowed, origin) {
  if (!allowed) return true;
  if (allowed === true) return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  const normalized = String(origin || '').trim();
  if (!normalized) return false;
  return list.includes(normalized);
}

module.exports = {
  nowMs,
  sanitizeText,
  generateToken,
  generateRoomCode,
  parseCorsOrigin,
  originIsAllowed,
};

