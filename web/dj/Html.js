// Html.js — text from outside never becomes markup.
//
// Track titles, artists, keys and genres come from Audius, SongChainn, share links and synced
// playlists. Wherever one goes into innerHTML it goes through esc(), so a title like
// <img onerror=...> shows as text instead of running. Safe inside an attribute value too.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
