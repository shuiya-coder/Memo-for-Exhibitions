// ===== links.js：メモのリンクをたどる部品（メモ画面と、見比べ画面で共通） =====
// リンクは、メモの中に { targetId, type } の形で入っている。
// type は "same"（同一作品）か "related"（関連作品）。

// 一覧用の説明：作品名 ／ 展覧会名 ／ No.
function describe(m) {
  return [m.title || "（作品名なし）", m.exhibition, m.catalog.no ? "No." + m.catalog.no : ""]
    .filter(Boolean).join(" ／ ");
}

// 同一作品のつながりをたどって、{ メモのid → 直接つながっているメモのid } を返す（自分は含まない）。
// 直接つないだメモは自分自身のid、間接のメモは、経由したメモのid が入る。
//   byId：{ id → メモ } の Map
function findSameGroup(byId, startId) {
  const via = new Map();
  const queue = [];
  for (const l of byId.get(startId).links || []) {
    if (l.type === "same" && byId.has(l.targetId)) { via.set(l.targetId, l.targetId); queue.push(l.targetId); }
  }
  while (queue.length) {
    const id = queue.shift();
    for (const l of byId.get(id).links || []) {
      if (l.type === "same" && l.targetId !== startId && byId.has(l.targetId) && !via.has(l.targetId)) {
        via.set(l.targetId, via.get(id)); // 経由は、最初に直接つながっているメモ
        queue.push(l.targetId);
      }
    }
  }
  return via;
}
