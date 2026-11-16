// ===== db.js：メモをブラウザの中（IndexedDB）に保存・取得する部品 =====
// IndexedDB は、ブラウザが持っている小さなデータベースです。
// ページを閉じても、同じブラウザなら中身が残ります。
// ただしブラウザのデータを消すと一緒に消えるので、あとで作る「JSON書き出し」でバックアップします。

const MemoDB = (() => {
  const DB_NAME = "exhibition-memo"; // データベースの名前
  const STORE = "memos";             // メモを入れる「箱」の名前
  const IMAGES = "images";           // 画像を入れる「箱」の名前

  // 画像を保存するときの上限
  const MAX_SIDE = 1600;                    // 長辺がこれより大きければ縮小する（ピクセル）
  const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024; // これ以下で、大きさも範囲内なら、そのまま保存する
  const MAX_FILE_BYTES = 30 * 1024 * 1024;    // これより大きいファイルは受け付けない
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // データベースを開く（なければ作る）。
  // バージョンを 1 → 2 に上げて、画像の箱を足した（今まで保存したメモは、そのまま残る）
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      // 初めて作るとき、またはバージョンが上がったときだけ呼ばれる：足りない箱を用意する
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(IMAGES)) {
          // 画像は id で見つける。メモごとの画像を探せるように、memoId でも探せるようにしておく
          const store = db.createObjectStore(IMAGES, { keyPath: "id" });
          store.createIndex("memoId", "memoId");
        }
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
      const tx = db.transaction([STORE, IMAGES], "readwrite");
      const store = tx.objectStore(STORE);
      const imageStore = tx.objectStore(IMAGES);
      for (const id of ids) {
        store.delete(id);
        // そのメモの画像も、いっしょに消す（メモがなくなった画像だけが残らないように）
        const keys = imageStore.index("memoId").getAllKeys(IDBKeyRange.only(id));
        keys.onsuccess = () => keys.result.forEach((key) => imageStore.delete(key));
      }
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

  // ----- 画像 -----

  // 画像の箱に対する、1回の操作（読む・書く）を行う共通の関数
  async function runImages(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES, mode);
      const request = action(tx.objectStore(IMAGES));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 画像ファイルを、保存する形（Blob と種類）にそろえる。
  // 大きい写真は、長辺 MAX_SIDE まで縮小して JPEG にする（保存の容量を抑えるため）。GIF はそのまま
  async function prepareImage(file) {
    if (!IMAGE_TYPES.includes(file.type)) {
      throw new Error("「" + file.name + "」は、PNG・JPEG・WebP・GIF の画像ではありません");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error("「" + file.name + "」は大きすぎます（30MB まで）");
    }
    if (file.type === "image/gif") return { blob: file, type: file.type };

    let bitmap;
    try {
      bitmap = await createImageBitmap(file); // 画像を読み込む（壊れたファイルならここで失敗する）
    } catch (e) {
      throw new Error("「" + file.name + "」を画像として読み込めませんでした");
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) {
      bitmap.close();
      return { blob: file, type: file.type }; // 小さい画像は、そのまま保存する
    }
    // 縮小して JPEG にする。背景が透明の PNG は、白い背景にする
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return { blob, type: "image/jpeg" };
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

    // メモの画像を追加する（縮小などをしてから保存）。戻り値：保存した画像
    // 画像は { id, memoId, name, type, blob, createdAt } の形で、メモとは別の箱に入れる
    addImage: async (memoId, file) => {
      const { blob, type } = await prepareImage(file);
      const image = {
        id: crypto.randomUUID(), memoId, name: file.name, type, blob,
        createdAt: new Date().toISOString(),
      };
      await runImages("readwrite", (s) => s.put(image));
      return image;
    },
    // メモの画像を、追加した順に返す
    getImages: async (memoId) => {
      const images = await runImages("readonly", (s) => s.index("memoId").getAll(IDBKeyRange.only(memoId)));
      return images.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    removeImage: (id) => runImages("readwrite", (s) => s.delete(id)),
    // 全部の画像（JSON の書き出し用）
    getAllImages: () => runImages("readonly", (s) => s.getAll()),
    // 画像をまとめて保存する（JSON の読み込み用）
    saveImages: async (images) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGES, "readwrite");
        for (const image of images) tx.objectStore(IMAGES).put(image);
        tx.oncomplete = () => resolve(images.length);
        tx.onerror = () => reject(tx.error);
      });
    },
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
