// ===== pdf-import.js：出品目録の「文字と位置」を、作品ごとのデータに組み立てる部品 =====
// 入力：PDF.js が取り出した文字のまとまり（items）。1つは { str: 文字, x: 左端, y: 高さ, w: 幅 }
// 出力：作品ごとの { no, designation, title, author, period, quantity, holder, section, ... }
//
// 考え方：
//   1. 同じ高さの文字を「行」にまとめる
//   2. 行の左端（No. の列）に数字があれば、そこが作品の始まり。数字でない文字なら「章の見出し」
//   3. 残りの行を上から順に区切って、作品ごとのグループにする（下で詳しく説明）
//   4. 作品の中では、x 座標で「どの列か」を決める
//
// 3 の区切り方：
//   この目録の表では、各作品の内容は、その作品の行の高さの「まんなか」に置かれています。
//   たとえば作者が12行ある作品は背が高く、No. はそのまんなかに書かれます。
//   そこで「グループのまんなかの高さが、その作品の No. の高さに最も近くなる区切り方」を選びます。
//   （単純に「いちばん近い No. に入れる」方式だと、背の高い作品の下のほうの行が、
//     すぐ下の作品に取られてしまうため）

const CatalogParser = (() => {
  // 列の名前（左から順）。最初の no は No. の列
  const COLUMNS = ["no", "designation", "title", "author", "period", "quantity", "holder", "term"];

  // 列の境目（x座標）の初期値。「指定」列以降の左端を並べたもの。
  // 例の目録に合わせた値。PDF が違えば、画面で変えられる。
  const DEFAULT_BOUNDS = [50, 70, 225, 310, 412, 465, 530];

  // 指定欄の記号と、その意味（例の目録の凡例による）
  const DESIGNATION_NAMES = { "◉": "国宝", "◎": "重要文化財" };

  const SAME_LINE = 3;      // 高さの差がこれ以内なら同じ行とみなす
  const MAX_DISTANCE = 150; // 作品の No. からこれより離れた文字は、作品の外の文字（ページ番号など）とみなす

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

  // 行の並び（上から下）を、作品ごとのグループに区切る。
  //   seq：行の並び（章の見出し行は除いてある）
  //   markers：各作品の { index: seq の中での No. の行の位置, y: No. の高さ }（上から順）
  // 戻り値：各作品のグループの最後の行の位置（seq の添字）の配列
  function splitGroups(seq, markers) {
    const R = markers.length;
    const last = seq.length - 1;
    // 作品 r が行 s〜e を持つときの「ずれ」：グループのまんなかの高さと No. の高さの差の2乗
    const cost = (r, s, e) => {
      const mid = (seq[s].y + seq[e].y) / 2;
      return (mid - markers[r].y) ** 2;
    };
    // 作品 r の最後の行 e として選べる範囲：自分の No. の行から、次の作品の No. の行の手前まで
    const range = (r) => [markers[r].index, r === R - 1 ? last : markers[r + 1].index - 1];

    // best[r][e]：作品 0〜r までを、作品 r が行 e で終わるように区切ったときの、ずれの合計の最小値
    const best = [];
    const back = []; // どの区切りから来たか（あとで逆にたどる）
    for (let r = 0; r < R; r++) {
      best.push({});
      back.push({});
      const [lo, hi] = range(r);
      for (let e = lo; e <= hi; e++) {
        if (r === 0) {
          best[r][e] = cost(0, 0, e); // 最初の作品は、先頭の行から始まる
        } else {
          let min = Infinity, from = -1;
          const [plo, phi] = range(r - 1);
          for (let p = plo; p <= phi; p++) {
            const c = best[r - 1][p] + cost(r, p + 1, e);
            if (c < min) { min = c; from = p; }
          }
          best[r][e] = min;
          back[r][e] = from;
        }
      }
    }

    // 最後の作品から逆にたどって、区切りを決める
    const ends = new Array(R);
    ends[R - 1] = last;
    for (let r = R - 1; r > 0; r--) ends[r - 1] = back[r][ends[r]];
    return ends;
  }

  // 1ページぶんを解析する。state.chapter は、前のページから続く章の名前
  function parsePage(items, bounds, state, pageNo) {
    // 「No.」の見出しがあれば、それより上（会期や注記など）は読み飛ばす
    const header = items.find((it) => it.str.trim() === "No." && it.x < bounds[0]);
    const body = header ? items.filter((it) => it.y < header.y - 2) : items;

    // 行に分け、「作品の始まりの行」「章の見出しの行」「それ以外」に分類する
    const rows = [];
    const markers = []; // 作品の始まりの行の位置
    const seq = [];     // 章の見出しを除いた、行の並び
    const consumed = new Set(); // 作品番号や章の見出しとして使った文字
    for (const line of groupLines(body)) {
      const noPart = line.items.filter((it) => it.x < bounds[0]);
      const noText = noPart.length ? joinLine(noPart).trim() : "";
      if (noPart.length && !/^\d+$/.test(noText)) {
        // No. の列に数字でない文字がある → 章の見出し（その行の文字はすべて見出しに使う）
        state.chapter = joinLine(line.items).trim();
        line.items.forEach((it) => consumed.add(it));
        continue;
      }
      if (noPart.length) {
        // 数字だけ → 作品の始まり
        rows.push({ no: noText, y: line.y, page: pageNo, section: state.chapter, items: [...noPart] });
        markers.push({ index: seq.length, y: line.y });
        noPart.forEach((it) => consumed.add(it));
      }
      seq.push(line);
    }

    // 行を、作品ごとのグループに区切って割り当てる
    const leftovers = [];
    if (rows.length === 0) {
      for (const line of seq) line.items.forEach((it) => leftovers.push(it.str));
    } else {
      const ends = splitGroups(seq, markers);
      let start = 0;
      rows.forEach((row, r) => {
        for (let i = start; i <= ends[r]; i++) {
          for (const it of seq[i].items) {
            if (consumed.has(it)) continue;
            // 作品の No. から離れすぎた文字は、作品の外の文字とみなす
            if (Math.abs(it.y - row.y) > MAX_DISTANCE) leftovers.push(it.str);
            else row.items.push(it);
          }
        }
        start = ends[r] + 1;
      });
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
