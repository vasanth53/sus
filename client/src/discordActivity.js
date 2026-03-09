import { DiscordSDK } from '@discord/embedded-app-sdk';

function getSearchParam(key) {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

export function isDiscordActivity() {
  // Common URL params in activities: frame_id, instance_id, platform
  return Boolean(getSearchParam('frame_id') || getSearchParam('instance_id') || getSearchParam('platform'));
}

export async function initDiscordActivity({ clientId }) {
  if (!clientId) return { ok: false, error: 'missing_client_id' };
  const discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  const channelId = getSearchParam('channel_id') || discordSdk.channelId || null;
  const guildId = getSearchParam('guild_id') || discordSdk.guildId || null;

  return { ok: true, discordSdk, channelId, guildId };
}

export async function discordAuthorizeAndAuthenticate(discordSdk, { scopes, redirectUri }) {
  const state = crypto.getRandomValues(new Uint8Array(16)).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');

  const auth = await discordSdk.commands.authorize({
    client_id: discordSdk.clientId,
    response_type: 'code',
    prompt: 'none',
    scope: scopes,
    state,
    redirect_uri: redirectUri,
  });

  return auth;
}

export async function exchangeCodeForToken({ proxyBase, code }) {
  const base = proxyBase || '';
  const res = await fetch(`${base}/api/discord/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    return { ok: false, error: 'token_exchange_failed', status: res.status };
  }
  const json = await res.json();
  return { ok: true, token: json.access_token };
}

export async function discordAuthenticate(discordSdk, accessToken) {
  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  return auth;
}

