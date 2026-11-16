// ===== search.js：メモの検索に使う部品（一覧とメモ画面のリンク探しで共通） =====

// 表記のゆれをそろえる：全角の英数字を半角に、大文字を小文字にする
// （例：「ＮＯ．１」と「no.1」を同じ扱いにできる）
function normalize(text) {
  return String(text).normalize("NFKC").toLowerCase();
}

// メモの中の検索対象の文字を、1つにつなげる
function searchText(m) {
  return normalize([
    m.title, m.exhibition, m.body, m.viewDate, m.references, // 古いメモでは未設定のことがある（空として扱われる）
    ...Object.values(m.catalog), // 目録番号・指定・作者・時代・制作地・員数・所蔵者・章
    ...m.tags,
  ].join("\n"));
}

// 検索ボックスの言葉（空白で区切った全部）を含むメモなら true
function matchesQuery(m, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true; // 何も入力されていなければ全部に合う
  const text = searchText(m);
  return words.every((w) => text.includes(w));
}
