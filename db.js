// ===== db.js：メモをブラウザの中（IndexedDB）に保存・取得する部品 =====
// IndexedDB は、ブラウザが持っている小さなデータベースです。
// ページを閉じても、同じブラウザなら中身が残ります。
// ただしブラウザのデータを消すと一緒に消えるので、あとで作る「JSON書き出し」でバックアップします。

const MemoDB = (() => {
  const DB_NAME = "exhibition-memo"; // データベースの名前
  const STORE = "memos";             // メモを入れる「箱」の名前

  // データベースを開く（なければ作る）
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      // 初めて作るときだけ呼ばれる：箱を用意し、idをキー（目印）にする
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 1回の操作（読む・書く）を行う共通の関数
  async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 空のメモを作る（まだ保存はしない）
  function create() {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),  // 重ならない目印
      title: "",                // 作品名
      exhibition: "",           // 展覧会名
      catalog: {                // 出品目録の情報
        no: "",                 //   目録番号
        designation: "",        //   文化財指定（国宝・重要文化財など）
        author: "",             //   作者名
        period: "",             //   時代・制作年代
        place: "",              //   制作地
        quantity: "",           //   員数
        holder: "",             //   所蔵者
        section: "",            //   章・区分
      },
      viewDate: "",             // 鑑賞日（任意。"2026-11-03" の形）
      body: "",                 // 自分のメモ
      references: "",           // 参考文献（任意。メモ画面で手入力する）
      favorite: false,          // お気に入り（true なら★）
      tags: [],                 // タグ（ステップ3で使う）
      links: [],                // 他メモへのリンク（ステップ6で使う）
      rawText: "",              // PDF取り込み時の元のテキスト（確認用）
      source: "",               // 取り込み元（PDFのファイル名とページ）
      createdAt: now,
      updatedAt: now,
    };
  }

  // 複数のメモをまとめて削除する。
  // あわせて、残ったメモの中にある「削除したメモへのリンク」も取り除く
  // （リンクは { targetId, type } の形。リンクだけが残ると、存在しないメモを指してしまうため）
  async function removeMany(ids) {
    const idSet = new Set(ids);
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      // 削除したあとに残っているメモを調べ、消えたメモへのリンクがあれば外して保存し直す
      const req = store.getAll();
      req.onsuccess = () => {
        for (const m of req.result) {
          const links = m.links || [];
          const kept = links.filter((l) => !idSet.has(l.targetId));
          if (kept.length !== links.length) {
            m.links = kept; // 更新日時は変えない（内容を直したわけではないため）
            store.put(m);
          }
        }
      };
      tx.oncomplete = () => resolve(ids.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 2つのメモ a, b の両方を書き換える共通の処理（リンクは双方向なので、両方に書く）。
  // 変更するのは links だけで、ほかの項目（編集中の内容など）には触らない。
  // 戻り値：a の新しい links
  async function updatePair(aId, bId, change) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let aLinks = [];
      const ra = store.get(aId);
      ra.onsuccess = () => {
        const rb = store.get(bId);
        rb.onsuccess = () => {
          const a = ra.result, b = rb.result;
          if (!a || !b) { tx.abort(); return; } // どちらかがなければ何もしない
          change(a, b);
          store.put(a);
          store.put(b);
          aLinks = a.links;
        };
      };
      tx.oncomplete = () => resolve(aLinks);
      tx.onabort = () => reject(new Error("リンク先のメモが見つかりません"));
      tx.onerror = () => reject(tx.error);
    });
  }

  // a と b の間のリンクをすべて取り除く（種類を変えるときにも使う）
  function dropLinks(a, b) {
    a.links = (a.links || []).filter((l) => l.targetId !== b.id);
    b.links = (b.links || []).filter((l) => l.targetId !== a.id);
  }

  return {
    create,
    // a と b をリンクする。type は "same"（同一作品）か "related"（関連作品）。
    // すでにリンクがあれば、種類を置き換える（2つのメモの間のリンクは1つだけ）
    addLink: (aId, bId, type) => updatePair(aId, bId, (a, b) => {
      dropLinks(a, b);
      a.links.push({ targetId: b.id, type });
      b.links.push({ targetId: a.id, type });
    }),
    // a と b の間のリンクを解除する
    removeLink: (aId, bId) => updatePair(aId, bId, dropLinks),
    // お気に入りの付け外し。更新日時は変えない（一覧の並び順が動かないようにするため）
    setFavorite: async (id, value) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) {
            req.result.favorite = value;
            store.put(req.result);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    getAll: () => run("readonly", (s) => s.getAll()),
    get: (id) => run("readonly", (s) => s.get(id)),
    // 保存（同じidがあれば上書き、なければ追加）
    save: (memo) => {
      memo.updatedAt = new Date().toISOString();
      return run("readwrite", (s) => s.put(memo));
    },
    remove: (id) => removeMany([id]),
    removeMany,
    // 複数のメモをまとめて保存する（読み込み用）。updatedAt は元の値のまま残す
    saveMany: async (memos) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const m of memos) store.put(m);
        tx.oncomplete = () => resolve(memos.length);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
})();
