// ===== card-import.js：「段組みカード形式」の出品目録を読む部品 =====
// 表（行と列）ではなく、作品ごとのまとまり（カード）が、縦の段に積まれている形式。
//
// 例（大徳寺の目録）：1ページに縦4段があり、各段に作品が上から下へ並ぶ。
//   [大きい文字の作品番号]
//   [指定記号] 作品名
//   作者名
//   員数　時代　年号・西暦
//   所蔵者
//   前期／後期 など
// 作品の間に罫線はなく、「番号から次の番号まで」が1作品になる。
//
// このファイルの役割（今は、作品のまとまりに区切るところまで）：
//   1. 同じ位置の同じ文字（重複）を除く
//   2. 作品番号を見つける：「数字だけ」「大きい文字」「増えていく連番」の3つを満たすもの
//   3. 作品番号の位置から、縦の段の左端を決め、文字を段に振り分ける
//   4. 段の中で、番号から次の番号の手前までを、1作品のまとまり（ブロック）にする
//      - 段の左端と揃っていない行（ページ上部の説明など）は、作品の外とする
//      - 「序章」「第1章」などの行は、章の見出しとして、次の作品の「章」にする
//   5. 作品のまとまりを、項目（作品名、作者名、員数、制作年代、所蔵者）に分ける（extractFields）
//      「員数の行」（最初の文字が「数字＋単位」の行）を目印にして、その前後から項目を決める。

const CardParser = (() => {
  const DEFAULT_OPTIONS = {
    // 作品番号とみなす文字の大きさ：数字だけの文字のうち、最大の大きさに対する割合
    numberSizeRatio: 0.8,
    // 章の見出しの行を見つける言葉（正規表現）
    chapterPattern: "^(序章|終章|第\\s*\\S{1,4}\\s*章|プロローグ|エピローグ)",
    // 「員数の行」を見つける言葉：行の最初の文字が「数字＋単位」（例：1 幅、3 幅、1 軀）。
    // 「49冊のうち4冊」のような書き方も含む。「13 世紀」「3 年」のような年代は、員数ではないので除く
    quantityPattern: "^\\d+\\s*[^\\d\\s世年月日紀]{1,3}(のうち.*)?$",
    // 展示期間の行を見つける言葉（空白を除いた行全体が、これに当てはまれば展示期間）：
    // 前期・後期・①～⑥、「10月14日～11月8日」のような日付 など
    termPattern: "^([前中後]期|[①-⑳㉑-㉟]|[～〜、・,]|\\d+月\\d+日|\\d+/\\d+|[（(][月火水木金土日祝・]+[）)])+$",
    // 員数の行のあとに続く、時代・年号・西暦の折り返しの行を見つける言葉
    continuationPattern: "世紀|年|時代|\\d{3,4}",
  };

  // 指定欄の記号と、その意味（例の目録の凡例による）
  const DESIGNATION_NAMES = { "◉": "国宝", "◎": "重要文化財" };
  // 指定ではない記号（★は「会期中に場面替え」の印）。取り込まない。元のテキストには残る
  const OTHER_MARKS = ["★", "☆"];
  const MARK_CHARS = "◉◎★☆";

  const CLUSTER_GAP = 6;   // x座標の差がこれ以内の番号は、同じ段のもの
  const COLUMN_MARGIN = 5; // 段の左端より、これだけ左から始まる文字まで、その段に入れる
  const ALIGN_LEFT = 3;    // 行の最初の文字が、段の左端から「左に3〜右に6」の範囲で始まらない行は、作品の外
  const ALIGN_RIGHT = 6;

  const { groupLines, joinLine } = CatalogParser;

  // 同じ文字・同じ位置の重複を除く（PDFによっては、同じ文字が2回重ねて入っている）
  function dedupe(items) {
    const seen = new Set();
    const result = [];
    for (const it of items) {
      const key = [it.str, it.x.toFixed(1), it.y.toFixed(1)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(it);
    }
    return result;
  }

  // x座標が近いものを、段ごとにまとめる。{ left: 段の左端, items } の並び（左の段から）
  function clusterByX(items) {
    const clusters = [];
    for (const it of [...items].sort((a, b) => a.x - b.x)) {
      const last = clusters[clusters.length - 1];
      if (last && it.x - last.left <= CLUSTER_GAP) last.items.push(it);
      else clusters.push({ left: it.x, items: [it] });
    }
    return clusters;
  }

  // 作品番号を見つける。
  //   数字だけの文字のうち、大きいものを候補にし、「段の左から順、段の中は上から順」に並べたとき、
  //   番号が増えていく最長の並び（連番）を、作品番号とする。
  //   （年号や員数の数字、ページ番号などを、作品番号と間違えないため）
  //   minValue：前のページまでの最後の作品番号。これ以下の数字は、作品番号とみなさない
  //   （巻末の地図の番号など、作品と関係のない数字を除くため）
  function pickNumbers(items, ratio, minValue) {
    const digits = items.filter((it) => /^\d{1,4}$/.test(it.str.trim()));
    if (digits.length === 0) return { markers: [], lefts: [], rejected: [], height: 0 };

    const height = Math.max(...digits.map((it) => it.h || 0));
    const big = digits.filter((it) => (it.h || 0) >= height * ratio && Number(it.str) > minValue);

    const order = clusterByX(big).flatMap((c) => c.items.sort((a, b) => b.y - a.y));
    const values = order.map((it) => Number(it.str));

    // 番号が増えていく、いちばん長い並びを探す（最長増加部分列）
    const n = order.length;
    const length = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (values[j] < values[i] && length[j] + 1 > length[i]) { length[i] = length[j] + 1; prev[i] = j; }
      }
    }
    let end = 0;
    for (let i = 0; i < n; i++) if (length[i] > length[end]) end = i;
    const chain = new Set();
    for (let i = end; i >= 0; i = prev[i]) chain.add(order[i]);

    const markers = order.filter((it) => chain.has(it));
    const rejected = digits.filter((it) => !chain.has(it)); // 作品番号とみなさなかった数字
    // 段の左端：作品番号の x座標を、近いもの同士でまとめて、いちばん左のものを使う
    const lefts = clusterByX(markers).map((c) => c.left);
    return { markers, lefts, rejected, height };
  }

  // 行に含まれる文字の大きさの中央値（確認用の表示に使う）
  function medianHeight(items) {
    const hs = items.map((it) => it.h || 0).sort((a, b) => a - b);
    return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  }

  // 1ページぶんを解析する。options は DEFAULT_OPTIONS と同じ形。
  // state.chapter は、前のページ・前の段から続く章の名前。state.lastNo は、前のページまでの最後の作品番号
  // 戻り値：{ blocks: 作品のまとまりの並び, ignored: 作品の外とした行, rejected: 番号と認めなかった数字, lefts, height }
  function parsePage(rawItems, options, state, pageNo) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const items = dedupe(rawItems);
    const { markers, lefts, rejected, height } = pickNumbers(items, opts.numberSizeRatio, state.lastNo || 0);
    // このページの最後の作品番号を覚えておく（次のページで、これより小さい数字を除くため）
    if (markers.length) state.lastNo = Math.max(...markers.map((it) => Number(it.str)));
    const result = { blocks: [], ignored: [], rejected: rejected.map((it) => it.str), lefts, height };

    // 作品番号が1つもないページ：すべて作品の外
    if (markers.length === 0) {
      for (const line of groupLines(items)) {
        result.ignored.push({ page: pageNo, column: 0, y: line.y, text: joinLine(line.items).trim(), h: medianHeight(line.items), reason: "作品番号がないページ" });
      }
      return result;
    }

    const markerSet = new Set(markers);
    const chapterRe = new RegExp(opts.chapterPattern);

    // 文字を、段に振り分ける（どの段の左端よりも左にある文字は「段の外」）
    const columns = lefts.map(() => []);
    const outside = [];
    for (const it of items) {
      let c = -1;
      lefts.forEach((left, i) => { if (it.x >= left - COLUMN_MARGIN) c = i; });
      (c < 0 ? outside : columns[c]).push(it);
    }
    for (const line of groupLines(outside)) {
      result.ignored.push({ page: pageNo, column: 0, y: line.y, text: joinLine(line.items).trim(), h: medianHeight(line.items), reason: "どの段にも入らない" });
    }

    // 段ごとに、上から下へ行を読み、作品のまとまりに区切る
    columns.forEach((colItems, ci) => {
      const left = lefts[ci];
      let block = null;   // いま集めている作品
      let heading = null; // 章の見出しとして集めている行（見出しは、次の作品番号までの行）

      // 集めた見出しの行を、章の名前として確定する
      const closeHeading = () => {
        if (heading) {
          state.chapter = heading.map((l) => l.text).join("　");
          heading = null;
        }
      };

      for (const line of groupLines(colItems)) {
        const first = line.items[0];
        const info = {
          page: pageNo, column: ci + 1, y: line.y,
          text: joinLine(line.items).trim(), h: medianHeight(line.items),
          items: line.items, // 項目への分け方で、文字ごとに調べるために残す
        };

        // 段の左端と揃っていない行（ページ上部の説明など）は、作品の外
        if (first.x < left - ALIGN_LEFT || first.x > left + ALIGN_RIGHT) {
          result.ignored.push({ ...info, reason: "段の左端と揃っていない" });
          continue;
        }

        // 作品番号の行：新しい作品の始まり
        const numberItem = line.items.find((it) => markerSet.has(it));
        if (numberItem) {
          closeHeading();
          block = { no: String(Number(numberItem.str)), page: pageNo, column: ci + 1, section: state.chapter, lines: [] };
          result.blocks.push(block);
          continue;
        }

        if (heading) {
          heading.push(info); // 章の見出しの続き
        } else if (chapterRe.test(info.text)) {
          heading = [info]; // 章の見出しの始まり。ここで、いまの作品は終わり
          block = null;
        } else if (block) {
          block.lines.push(info);
        } else {
          result.ignored.push({ ...info, reason: "作品番号より上にある" });
        }
      }
      closeHeading();
    });

    for (const b of result.blocks) b.rawText = b.lines.map((l) => l.text).join("\n");
    return result;
  }

  // ----- 作品のまとまり（ブロック）を、項目に分ける -----

  // 年号や員数の中の余計な空白を取る（「（ 1299 ）」→「（1299）」、「13 世紀」→「13世紀」）。
  // 日本語・数字・かっこの隣にある空白だけを取る
  function tidy(s) {
    return s.replace(/(?<=[\u0080-￿0-9()])\s+|\s+(?=[\u0080-￿0-9()])/g, "").trim();
  }

  // 行の先頭にある記号（◎ ◉ ★）を取り出す。戻り値：{ marks: 記号の並び, items: 記号を除いた文字 }
  function splitMarks(items) {
    const marks = [];
    const rest = [];
    let atStart = true; // 行の先頭の記号を調べている間は true
    const markRe = new RegExp("^([" + MARK_CHARS + "\\s]+)(.*)$");
    for (const it of items) {
      let str = it.str;
      if (atStart) {
        const m = str.trim().match(markRe);
        if (m && m[1].trim()) {
          marks.push(...m[1].replace(/\s/g, "").split(""));
          str = m[2];
          if (str.trim() === "") continue; // 記号だけの文字。次の文字も、記号かもしれない
        }
      }
      atStart = false;
      rest.push({ ...it, str });
    }
    return { marks, items: rest };
  }

  // 作品のまとまり1つを、項目に分ける。確認用の表の1行ぶん（表形式と同じ形）を返す
  function extractFields(block, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const quantityRe = new RegExp(opts.quantityPattern);
    const termRe = new RegExp(opts.termPattern);
    const continuationRe = new RegExp(opts.continuationPattern);

    const row = {
      no: block.no, designation: "", title: "", author: "", period: "", place: "",
      quantity: "", holder: "", section: block.section, page: block.page,
      rawText: block.rawText, note: "",
    };
    const notes = []; // 「要確認」の欄に出す、うまく分けられなかった理由

    // 取り込まない行を除く：展示期間の行（前期・後期・①～⑥）と、「★」だけの行（場面替えの印）
    const lines = block.lines.filter((l) => {
      const t = l.text.replace(/\s/g, "");
      return !termRe.test(t) && !/^[★☆]+$/.test(t);
    });
    if (lines.length === 0) {
      row.note = "中身が空";
      return row;
    }

    // 1行目：作品名（先頭の記号は、指定として取り出す）
    const first = splitMarks(lines[0].items);
    row.designation = first.marks
      .filter((m) => !OTHER_MARKS.includes(m))
      .map((m) => DESIGNATION_NAMES[m] || m)
      .join("、");
    const titleParts = [joinLine(first.items).trim()];

    // 目印：員数の行を探す（2行目以降で、最初の文字が「数字＋単位」の行）
    let anchor = -1;
    for (let i = 1; i < lines.length; i++) {
      if (quantityRe.test(lines[i].items[0].str.trim())) { anchor = i; break; }
    }
    // 見つからなければ、「数字で始まり、時代・世紀を含む行」を目印にする（員数が変わった書き方のとき）
    if (anchor < 0) {
      for (let i = 1; i < lines.length; i++) {
        if (/^\d/.test(lines[i].items[0].str.trim()) && /時代|世紀/.test(lines[i].text)) { anchor = i; break; }
      }
    }
    if (anchor < 0) {
      row.title = titleParts[0];
      row.note = "員数の行が見つかりません";
      return row;
    }

    // 作品名の行と目印の間：いちばん下の行が作者名。それより上にも行があれば、作品名の続き
    const between = lines.slice(1, anchor);
    if (between.length >= 1) row.author = joinLine(between[between.length - 1].items).trim();
    // 作品名が複数行に折り返されているときは、作品名の続きとして結合する（注意は出さない）
    if (between.length >= 2) {
      between.slice(0, -1).forEach((l) => titleParts.push(joinLine(l.items).trim()));
    }
    row.title = titleParts.filter(Boolean).join("　");

    // 目印の行：1つ目が員数。最後の「…時代」の文字までが時代（「元時代／鎌倉時代」のように複数のこともある）、
    // そのあとが年号・西暦
    const anchorItems = lines[anchor].items;
    row.quantity = tidy(anchorItems[0].str);
    const rest = anchorItems.slice(1);
    let lastEra = -1;
    rest.forEach((it, i) => { if (/時代/.test(it.str)) lastEra = i; });
    const era = rest.slice(0, lastEra + 1).map((it) => tidy(it.str)).join("");
    const years = rest.slice(lastEra + 1).map((it) => tidy(it.str));

    // 年号・西暦が次の行に折り返されていれば、続ける
    let next = anchor + 1;
    while (next < lines.length && continuationRe.test(lines[next].text)) {
      years.push(tidy(lines[next].text));
      next++;
    }
    row.period = [era, years.join("")].filter(Boolean).join("　");

    // その次の行が所蔵者。そのあとに行があれば、取り込まず、「要確認」にその内容を出す
    // （展示の付記などのはず。元のテキストには残る）
    if (next < lines.length) {
      row.holder = joinLine(lines[next].items).trim();
      if (next + 1 < lines.length) {
        const extra = lines.slice(next + 1).map((l) => l.text).join(" ／ ");
        notes.push("所蔵者の後に行がある（取り込まない）：「" + extra + "」");
      }
    } else {
      notes.push("所蔵者が見つかりません");
    }
    if (!row.title) notes.push("作品名が空");

    row.note = notes.join("／");
    return row;
  }

  return { DEFAULT_OPTIONS, parsePage, extractFields };
})();
