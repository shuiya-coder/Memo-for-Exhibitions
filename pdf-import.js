// ===== pdf-import.js：出品目録の「文字と位置」を、作品ごとのデータに組み立てる部品 =====
// 入力：PDF.js が取り出した文字のまとまり（items）。1つは { str: 文字, x: 左端, y: 高さ, w: 幅 }
// 出力：作品ごとの { no, designation, title, author, period, place, quantity, holder, section, ... }
//
// 列の決め方：
//   目録によって、列の並びや、どんな列があるかが違う。そこで「列の定義」を使う。
//   列の定義 columns は { field: 何の項目か, left: 列の左端のx座標 } の並びで、
//   文字の左端のxが left 以上で、次の列の left より小さければ、その列の文字とみなす。
//   field は FIELD_LABELS のどれか。"ignore" は、使わない列（展示期間など）。
//   列の定義は、見出しの文字から自動で作る（detectColumns）。手で直すこともできる。
//
// 作品の分け方：
//   1. 同じ高さの文字を「行」にまとめる
//   2. No. の列に数字があれば、そこが作品の始まり。数字でない文字なら「章の見出し」
//   3. 残りの行を上から順に区切って、作品ごとのグループにする（下で詳しく説明）
//   4. 作品の中では、列の定義で「どの項目か」を決める
//
// 3 の区切り方：
//   この目録の表では、各作品の内容は、その作品の行の高さの「まんなか」に置かれています。
//   たとえば作者が12行ある作品は背が高く、No. はそのまんなかに書かれます。
//   そこで「グループのまんなかの高さが、その作品の No. の高さに最も近くなる区切り方」を選びます。
//   （単純に「いちばん近い No. に入れる」方式だと、背の高い作品の下のほうの行が、
//     すぐ下の作品に取られてしまうため）

const CatalogParser = (() => {
  // 項目の名前と、画面に出す名前
  const FIELD_LABELS = {
    no: "No.（作品番号）",
    designation: "文化財指定",
    title: "作品名",
    author: "作者名",
    period: "時代・制作年代",
    place: "制作地",
    quantity: "員数",
    holder: "所蔵者",
    ignore: "（使わない列）",
  };

  // 列の定義の初期値（最初に例として使った目録に合わせたもの）。
  // no の列の left は 0 にして、それより左の文字（章の見出しなど）も No. の列に入れる
  const DEFAULT_COLUMNS = [
    { field: "no", left: 0 },
    { field: "designation", left: 50 },
    { field: "title", left: 70 },
    { field: "author", left: 225 },
    { field: "period", left: 310 },
    { field: "quantity", left: 412 },
    { field: "holder", left: 465 },
    { field: "ignore", left: 530 }, // 展示期間（前期・中期・後期）。文字ではないので使わない
  ];

  // 見出しの文字と、項目の対応（見出しから列を自動で決めるときに使う）
  const FIELD_WORDS = {
    no: ["No.", "No", "番号", "作品番号", "出品番号", "図録番号"],
    designation: ["指定", "文化財指定", "文化財", "指定区分"],
    title: ["作品名", "名称", "作品", "題名", "作品名称"],
    author: ["作者名", "作者", "作家", "作家名", "筆者"],
    period: ["時代", "年代", "制作年代", "制作年", "時代・年代", "時代・制作年代", "制作時代"],
    place: ["制作地", "産地", "制作地域"],
    quantity: ["員数", "数量", "点数"],
    holder: ["所蔵者", "所蔵", "所蔵先", "所蔵館", "所蔵機関", "所蔵者名"],
    ignore: ["展示期間", "期間", "会期", "備考", "寸法", "法量", "材質", "技法", "形状"],
  };

  // 文字をそろえる：全角を半角に、空白を取り、小文字にする
  const norm = (s) => String(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();

  const WORD_TO_FIELD = new Map();
  for (const [field, words] of Object.entries(FIELD_WORDS)) {
    for (const w of words) WORD_TO_FIELD.set(norm(w), field);
  }

  // 指定欄の記号と、その意味（例の目録の凡例による）
  const DESIGNATION_NAMES = { "◉": "国宝", "◎": "重要文化財" };

  // 指定欄に書かれる言葉。これだけの行は、章の見出しではなく、作品の行の続きとみなす
  const DESIGNATION_WORDS = new Set(
    ["◉", "◎", "○", "●", "国宝", "重文", "重要文化財", "重美", "重要美術品"].map(norm));

  const SAME_LINE = 3;      // 高さの差がこれ以内なら同じ行とみなす
  const MAX_DISTANCE = 150; // 作品の No. からこれより離れた文字は、作品の外の文字（ページ番号など）とみなす
  const HEADER_ABOVE = 20;  // 見出しが2行のとき、No. の行の何ポイント上まで見出しとして探すか
  const HEADER_MARGIN = 6;  // 見出しの左端から、この分だけ左を列の左端にする（データは見出しより少し左から始まることがある）

  // 列の定義を、左から順に並べる（同じ left なら、あとに書いたものを優先）
  function sortColumns(columns) {
    return columns.map((c, i) => ({ ...c, i }))
      .sort((a, b) => (a.left - b.left) || (a.i - b.i));
  }

  // x座標から、どの項目の列かを求める。いちばん左の列より左なら、いちばん左の列とする
  function fieldOf(x, columns) {
    let field = columns[0].field;
    for (const c of columns) if (x >= c.left) field = c.field;
    return field;
  }

  // 見出しの文字（項目と位置 x）から、列の定義を作る。
  //   cells：{ field: 項目, x: 見出しの左端 } の並び
  //   bodyItems：見出しより下にある文字（データ）。列の左端をデータの位置に合わせるために使う
  // 列の左端は、No. の列だけは 0（いちばん左まで）、ほかは見出しの左端から決める。
  // データの文字が、見出しより左から始まる目録もある（見出しは中央ぞろえなど）ので、
  // 見出しの少し左〜少し右に始まるデータがあれば、その左端より1つ左を列の左端にする
  function buildColumns(cells, bodyItems) {
    const bodyXs = bodyItems.map((it) => it.x);
    const leftFor = (h) => {
      const byMargin = h - HEADER_MARGIN;
      const near = bodyXs.filter((x) => x >= h - 10 && x <= h + 4);
      return near.length ? Math.min(byMargin, Math.floor(Math.min(...near)) - 1) : byMargin;
    };
    let columns = cells.map((c) => ({
      field: c.field,
      left: c.field === "no" ? 0 : Math.round(leftFor(c.x)),
    }));
    // ほとんど同じ位置に「使わない列」と別の列があれば、別の列を残す
    columns = columns.filter((c) =>
      c.field !== "ignore" || !columns.some((o) => o.field !== "ignore" && Math.abs(o.left - c.left) <= 2));
    return sortColumns(columns).map(({ field, left }) => ({ field, left }));
  }

  // 文字から、項目を推測する（見出しの言葉に当てはまらなければ null）
  function guessField(str) {
    return WORD_TO_FIELD.get(norm(str)) || null;
  }

  // 見出しの文字と位置から、列の定義を作る。読み取れなければ null
  function detectColumns(items) {
    // 「No.」の見出しを探す（いちばん左にあるもの）
    const noItem = items
      .filter((it) => WORD_TO_FIELD.get(norm(it.str)) === "no")
      .sort((a, b) => (a.x - b.x) || (b.y - a.y))[0];
    if (!noItem) return null;

    // No. と同じ行の文字は、見出しの1つとして列にする（知らない言葉は「使わない列」）。
    // No. の少し上の行（2行の見出し）は、知っている言葉だけを使う
    const candidates = [];
    for (const it of items) {
      const dy = it.y - noItem.y;
      const field = WORD_TO_FIELD.get(norm(it.str));
      if (Math.abs(dy) <= SAME_LINE) candidates.push({ field: field || "ignore", left: it.x, rank: 0 });
      else if (dy > SAME_LINE && dy <= HEADER_ABOVE && field) candidates.push({ field, left: it.x, rank: 1 });
    }

    // 同じ項目の見出しが複数あれば、No. と同じ行のものを優先して1つだけ使う
    const chosen = [];
    const used = new Set();
    for (const c of candidates.sort((a, b) => a.rank - b.rank)) {
      if (c.field !== "ignore") {
        if (used.has(c.field)) continue;
        used.add(c.field);
      }
      chosen.push(c);
    }

    const columns = buildColumns(
      chosen.map((c) => ({ field: c.field, x: c.left })),
      items.filter((it) => it.y < noItem.y - 2));
    if (!used.has("no") || !used.has("title") || columns.length < 3) return null;
    return columns;
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

  // 1ページぶんを解析する。columns は列の定義。state.chapter は、前のページから続く章の名前
  function parsePage(items, columnDefs, state, pageNo) {
    const columns = sortColumns(columnDefs);

    // 「No.」の見出しがあれば、それより上（会期や注記など）は読み飛ばす
    const header = items.find((it) =>
      WORD_TO_FIELD.get(norm(it.str)) === "no" && fieldOf(it.x, columns) === "no");
    const body = header ? items.filter((it) => it.y < header.y - 2) : items;

    // 行に分け、「作品の始まりの行」「章の見出しの行」「それ以外」に分類する
    const rows = [];
    const markers = []; // 作品の始まりの行の位置
    const seq = [];     // 章の見出しを除いた、行の並び
    const consumed = new Set(); // 作品番号や章の見出しとして使った文字
    const isDigits = (it) => /^\d+$/.test(it.str.trim());
    for (const line of groupLines(body)) {
      // 行の左端から続く、No. の列の数字（「1」「12」など）を探す
      const noPart = [];
      for (const it of line.items) {
        if (fieldOf(it.x, columns) === "no" && isDigits(it)) noPart.push(it);
        else break;
      }

      if (noPart.length) {
        // 行の左端が数字 → 作品の始まり。
        // 同じ行の No. の列に、数字でない文字（指定の「重文」など）がはみ出していても、作品の始まりのまま
        rows.push({ no: joinLine(noPart).trim(), y: line.y, page: pageNo, section: state.chapter, items: [...noPart] });
        markers.push({ index: seq.length, y: line.y });
        noPart.forEach((it) => consumed.add(it));
      } else {
        // 数字で始まらない行。No. の列に文字があれば、章の見出し。
        // ただし「国宝」「重文」など指定の言葉だけなら、作品の行の続きなので見出しにしない
        const inNoColumn = line.items.filter((it) => fieldOf(it.x, columns) === "no");
        if (inNoColumn.length && !DESIGNATION_WORDS.has(norm(joinLine(inNoColumn)))) {
          state.chapter = joinLine(line.items).trim();
          line.items.forEach((it) => consumed.add(it));
          continue;
        }
      }
      seq.push(line);
    }
    // No. の列にはみ出した文字（数字でないもの）は、No. のすぐ右の列の文字として扱う
    const noIndex = columns.findIndex((c) => c.field === "no");
    const afterNo = (columns[noIndex + 1] || { field: "ignore" }).field;

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

    // 作品ごとに、列の定義で項目に振り分けて文字をつなぐ
    const result = rows.map((row) => {
      const byField = {};
      for (const it of row.items) {
        let f = fieldOf(it.x, columns);
        if (f === "no") f = afterNo; // 作品番号の数字以外は、No. のすぐ右の列の文字
        (byField[f] = byField[f] || []).push(it);
      }

      // 項目の中は、上の行から順に（行をまたいだ分は区切りなしでつなぐ）
      const text = (name) =>
        groupLines(byField[name] || []).map((l) => joinLine(l.items)).join("").trim();

      const mark = text("designation");
      return {
        no: row.no,
        designation: DESIGNATION_NAMES[mark] || mark,
        title: text("title"),
        author: text("author"),
        period: text("period"),
        place: text("place"),
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

  return { FIELD_LABELS, DEFAULT_COLUMNS, detectColumns, buildColumns, guessField, parsePage };
})();
