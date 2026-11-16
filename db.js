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
      body: "",                 // 自分のメモ
      tags: [],                 // タグ（ステップ3で使う）
      links: [],                // 他メモへのリンク（ステップ6で使う）
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    create,
    getAll: () => run("readonly", (s) => s.getAll()),
    get: (id) => run("readonly", (s) => s.get(id)),
    // 保存（同じidがあれば上書き、なければ追加）
    save: (memo) => {
      memo.updatedAt = new Date().toISOString();
      return run("readwrite", (s) => s.put(memo));
    },
    remove: (id) => run("readwrite", (s) => s.delete(id)),
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
