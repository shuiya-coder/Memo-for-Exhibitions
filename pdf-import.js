// ===== pdf-import.js：出品目録の「文字と位置」を、作品ごとのデータに組み立てる部品 =====
// 入力：PDF.js が取り出した文字のまとまり（items）。1つは { str: 文字, x: 左端, y: 高さ, w: 幅 }
// 出力：作品ごとの { no, designation, title, author, period, quantity, holder, section, ... }
//
// 考え方：
//   1. 同じ高さの文字を「行」にまとめる
//   2. 行の左端（No. の列）に数字があれば、そこが作品の始まり。数字でない文字なら「章の見出し」
//   3. それ以外の文字は、いちばん近い高さの作品に割り当てる（員数などが上下にずれるため）
//   4. 作品の中では、x 座標で「どの列か」を決める

const CatalogParser = (() => {
  // 列の名前（左から順）。最初の no は No. の列
  const COLUMNS = ["no", "designation", "title", "author", "period", "quantity", "holder", "term"];

  // 列の境目（x座標）の初期値。「指定」列以降の左端を並べたもの。
  // 例の目録に合わせた値。PDF が違えば、画面で変えられる。
  const DEFAULT_BOUNDS = [50, 70, 225, 310, 412, 465, 530];

  // 指定欄の記号と、その意味（例の目録の凡例による）
  const DESIGNATION_NAMES = { "◉": "国宝", "◎": "重要文化財" };

  const SAME_LINE = 3;     // 高さの差がこれ以内なら同じ行とみなす
  const MAX_DISTANCE = 40; // 近い作品の行がこれより離れていたら、作品の外の文字（ページ番号など）とみなす

  // x座標から、列の番号（COLUMNS の何番目か）を求める
  function columnOf(x, bounds) {
    let index = 0;
    for (const b of bounds) if (x >= b) index++;
    return index;
  }

  // 高さが近い文字を1行にまとめる。上の行から順に返す
  function groupLines(items) {
    const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && last.y - it.y <= SAME_LINE) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
  }

  // 1行ぶんの文字を左から順につなぐ。文字と文字のすき間が大きいときは全角スペースを入れる
  function joinLine(items) {
    let text = "";
    let prevEnd = null;
    for (const it of items) {
      if (prevEnd !== null && it.x - prevEnd > 3 && !/\s$/.test(text)) text += "　";
      text += it.str;
      prevEnd = it.x + it.w;
    }
    return text;
  }

  // 1ページぶんを解析する。state.chapter は、前のページから続く章の名前
  function parsePage(items, bounds, state, pageNo) {
    // 「No.」の見出しがあれば、それより上（会期や注記など）は読み飛ばす
    const header = items.find((it) => it.str.trim() === "No." && it.x < bounds[0]);
    const body = header ? items.filter((it) => it.y < header.y - 2) : items;

    const rows = [];
    const consumed = new Set(); // 作品番号や章の見出しとして使った文字
    for (const line of groupLines(body)) {
      const noPart = line.items.filter((it) => it.x < bounds[0]);
      if (noPart.length === 0) continue;
      const noText = joinLine(noPart).trim();
      if (/^\d+$/.test(noText)) {
        // 数字だけ → 作品の始まり
        rows.push({ no: noText, y: line.y, page: pageNo, section: state.chapter, items: [...noPart] });
        noPart.forEach((it) => consumed.add(it));
      } else {
        // 数字でない → 章の見出し（その行の文字はすべて見出しに使う）
        state.chapter = joinLine(line.items).trim();
        line.items.forEach((it) => consumed.add(it));
      }
    }

    // 残りの文字を、いちばん近い高さの作品に割り当てる
    const leftovers = [];
    for (const it of body) {
      if (consumed.has(it)) continue;
      let best = null;
      for (const row of rows) {
        if (!best || Math.abs(row.y - it.y) < Math.abs(best.y - it.y)) best = row;
      }
      if (best && Math.abs(best.y - it.y) <= MAX_DISTANCE) best.items.push(it);
      else leftovers.push(it.str);
    }

    // 作品ごとに、列に振り分けて文字をつなぐ
    const result = rows.map((row) => {
      const byColumn = {};
      for (const name of COLUMNS) byColumn[name] = [];
      for (const it of row.items) byColumn[COLUMNS[columnOf(it.x, bounds)]].push(it);

      // 列の中は、上の行から順に（行をまたいだ分は区切りなしでつなぐ）
      const text = (name) =>
        groupLines(byColumn[name]).map((l) => joinLine(l.items)).join("").trim();

      const mark = text("designation");
      return {
        no: row.no,
        designation: DESIGNATION_NAMES[mark] || mark,
        title: text("title"),
        author: text("author"),
        period: text("period"),
        quantity: text("quantity"),
        holder: text("holder"),
        section: row.section,
        page: row.page,
        // 元のテキスト（確認用）：その作品に割り当てた文字を、行ごとに並べたもの
        rawText: groupLines(row.items).map((l) => joinLine(l.items)).join("\n"),
      };
    });

    return { rows: result, leftovers };
  }

  return { COLUMNS, DEFAULT_BOUNDS, parsePage };
})();
