// quickRepliesStore.js
// Salva e carrega até 50 respostas rápidas via localStorage.
// Não apaga em logout e não depende do servidor.

const QR_STORAGE_VERSION = 1;
const QR_MAX = 50;

// Chave global (todas as lojas usam o mesmo conjunto)
const QR_KEY_GLOBAL = `ml_quick_replies_v${QR_STORAGE_VERSION}`;

// Se você quiser que CADA LOJA tenha suas próprias respostas, use esta função.
// Se preferir um conjunto único para todas as lojas, deixe como está no load/save (global).
function qrKeyByStore(storeKey) {
  return `ml_quick_replies_v${QR_STORAGE_VERSION}:${storeKey}`;
}

// ✅ Defaults (opcional): se não existir nada salvo ainda, começa com 50 vazias.
// Se você quiser, pode preencher algumas aqui.
function buildDefaultReplies() {
  return Array.from({ length: QR_MAX }, (_, i) => ({
    id: i + 1,
    title: `Resposta ${i + 1}`,
    text: "",
  }));
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeReplies(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];

  for (let i = 0; i < Math.min(arr.length, QR_MAX); i++) {
    const r = arr[i] || {};
    out.push({
      id: Number(r.id ?? i + 1),
      title: String(r.title ?? `Resposta ${i + 1}`),
      text: String(r.text ?? ""),
    });
  }

  // completa até 50
  while (out.length < QR_MAX) {
    const i = out.length;
    out.push({ id: i + 1, title: `Resposta ${i + 1}`, text: "" });
  }

  return out;
}

/**
 * Carrega respostas rápidas.
 * storeKey:
 *  - se você quer por loja, passe um identificador fixo da loja (ex: sellerId)
 *  - se quer global, passe null/undefined
 */
export function loadQuickReplies(storeKey = null, { perStore = false } = {}) {
  const key = perStore && storeKey ? qrKeyByStore(storeKey) : QR_KEY_GLOBAL;

  const raw = localStorage.getItem(key);
  if (!raw) {
    const defaults = buildDefaultReplies();
    localStorage.setItem(key, JSON.stringify(defaults));
    return defaults;
  }

  return normalizeReplies(safeJsonParse(raw, buildDefaultReplies()));
}

export function saveQuickReplies(replies, storeKey = null, { perStore = false } = {}) {
  const key = perStore && storeKey ? qrKeyByStore(storeKey) : QR_KEY_GLOBAL;
  const normalized = normalizeReplies(replies);
  localStorage.setItem(key, JSON.stringify(normalized));
  return normalized;
}

export function updateQuickReply(indexZeroBased, patch, storeKey = null, { perStore = false } = {}) {
  const replies = loadQuickReplies(storeKey, { perStore });
  if (indexZeroBased < 0 || indexZeroBased >= QR_MAX) return replies;

  replies[indexZeroBased] = {
    ...replies[indexZeroBased],
    ...patch,
    id: indexZeroBased + 1,
  };

  return saveQuickReplies(replies, storeKey, { perStore });
}

export function resetQuickReplies(storeKey = null, { perStore = false } = {}) {
  const key = perStore && storeKey ? qrKeyByStore(storeKey) : QR_KEY_GLOBAL;
  const defaults = buildDefaultReplies();
  localStorage.setItem(key, JSON.stringify(defaults));
  return defaults;
}
