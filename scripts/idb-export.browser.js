async function gprcExportIdb() {
  const DB_NAME = "earthwork-corridor";

  const open = (name) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error || new Error("Could not open IndexedDB."));
      req.onsuccess = () => resolve(req.result);
    });

  const readOptional = (db, store) =>
    db.objectStoreNames.contains(store) ? readStore(db, store) : Promise.resolve([]);

  const readStore = (db, store) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const os = tx.objectStore(store);
      const req = os.openCursor();
      const entries = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(entries);
          return;
        }
        entries.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error("Could not read store."));
    });

  const blobToPayload = (blob) => {
    if (!blob) return Promise.resolve(null);
    return blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { mime: blob.type || "application/octet-stream", base64: btoa(binary) };
    });
  };

  const catalog = await indexedDB.databases();
  const db = await open(DB_NAME);
  try {
    const projectRows = await readOptional(db, "projects");
    const metaRows = await readOptional(db, "meta");
    const pdfRows = await readOptional(db, "pdfs");
    const planRows = await readOptional(db, "plans");
    const gprcRows = await readOptional(db, "gprc");
    const pdfs = await Promise.all(
      pdfRows.map((row) => blobToPayload(row.value).then((file) => ({ id: String(row.key), file }))),
    );
    const plans = await Promise.all(
      planRows.map((row) => blobToPayload(row.value).then((file) => ({ id: String(row.key), file }))),
    );
    return {
      catalog,
      stores: [...db.objectStoreNames],
      projects: projectRows.map((row) => row.value),
      meta: metaRows.map((row) => ({ key: String(row.key), value: row.value })),
      pdfs,
      plans,
      gprc: gprcRows.map((row) => ({ id: String(row.key), record: row.value })),
    };
  } finally {
    db.close();
  }
}
