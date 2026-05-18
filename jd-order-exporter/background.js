const cancelledJobs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "JD_EXPORT_CANCEL") {
    const jobKey = makeJobKey(sender, message.jobId);
    if (jobKey) cancelledJobs.add(jobKey);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "JD_EXPORT_DOWNLOAD_XLSX") {
    const { filename, rows, columns, imagePreviews, options, jobId } = message;
    if (!filename || !Array.isArray(rows) || !Array.isArray(columns)) {
      sendResponse({ ok: false, error: "Invalid Excel payload" });
      return false;
    }

    const jobKey = makeJobKey(sender, jobId);
    cancelledJobs.delete(jobKey);
    downloadXlsx(
      filename,
      rows,
      columns,
      imagePreviews || [],
      normalizeImageOptions(options),
      makeProgressReporter(sender),
      makeCancellationChecker(jobKey)
    )
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }))
      .finally(() => clearCancelledJob(jobKey));

    return true;
  }

  if (message.type === "JD_EXPORT_DOWNLOAD_IMAGES_ZIP") {
    const { filename, entries, options, jobId } = message;
    if (!filename || !Array.isArray(entries)) {
      sendResponse({ ok: false, error: "Invalid image zip payload" });
      return false;
    }

    const jobKey = makeJobKey(sender, jobId);
    cancelledJobs.delete(jobKey);
    downloadImagesZip(
      filename,
      entries,
      normalizeImageOptions(options),
      makeProgressReporter(sender),
      makeCancellationChecker(jobKey)
    )
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }))
      .finally(() => clearCancelledJob(jobKey));

    return true;
  }

  if (message.type === "JD_EXPORT_CLEAR_IMAGE_CACHE") {
    clearImageCache()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message.type !== "JD_EXPORT_DOWNLOAD") return false;

  const { filename, content, mimeType } = message;
  if (!filename || typeof content !== "string") {
    sendResponse({ ok: false, error: "Invalid download payload" });
    return false;
  }

  const url = toDataUrl(content, mimeType || "text/plain;charset=utf-8");
  chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ ok: true, downloadId });
  });

  return true;
});

function toDataUrl(content, mimeType) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function makeProgressReporter(sender) {
  return (message) => {
    const tabId = sender?.tab?.id;
    if (!tabId || !message) return;
    chrome.tabs.sendMessage(tabId, {
      type: "JD_EXPORT_PROGRESS",
      message
    }, () => {
      void chrome.runtime.lastError;
    });
  };
}

function makeJobKey(sender, jobId) {
  const tabId = sender?.tab?.id;
  if (!tabId || !jobId) return "";
  return `${tabId}:${jobId}`;
}

function makeCancellationChecker(jobKey) {
  return () => Boolean(jobKey) && cancelledJobs.has(jobKey);
}

function clearCancelledJob(jobKey) {
  if (jobKey) cancelledJobs.delete(jobKey);
}

function normalizeImageOptions(options = {}) {
  return {
    delayMs: Math.max(0, Number(options.delayMs) || 0),
    batchSize: Math.max(1, Number(options.batchSize) || 50),
    batchPauseMs: Math.max(0, Number(options.batchPauseMs) || 0),
    maxConsecutiveFailures: Math.max(1, Number(options.maxConsecutiveFailures) || 3),
    cacheEnabled: options.cacheEnabled !== false,
    cacheTtlDays: Math.max(0, Number(options.cacheTtlDays) || 0)
  };
}

async function throttleImageRequest(done, total, options, reportProgress, label, isCancelled) {
  if (done >= total) return;
  if (options.delayMs > 0) {
    await sleepInterruptible(options.delayMs, isCancelled);
  }
  if (options.batchPauseMs > 0 && done > 0 && done % options.batchSize === 0) {
    reportProgress(`${label} 已处理 ${done} / ${total}，休息 ${Math.round(options.batchPauseMs / 1000)} 秒后继续`);
    await sleepInterruptible(options.batchPauseMs, isCancelled);
  }
}

function assertImageFailures(consecutiveFailures, options) {
  if (consecutiveFailures >= options.maxConsecutiveFailures) {
    throw new Error(`连续 ${consecutiveFailures} 张图片下载失败，已暂停以避免触发验证。请稍后重试，或调大图片间隔/批次休息。`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepInterruptible(ms, isCancelled) {
  const step = 250;
  let remaining = ms;
  while (remaining > 0) {
    if (isCancelled()) throw new Error("EXPORT_CANCELLED");
    const wait = Math.min(step, remaining);
    await sleep(wait);
    remaining -= wait;
  }
}

async function downloadImagesZip(filename, entries, options, reportProgress = () => {}, isCancelled = () => false) {
  const zipEntries = [];
  const errors = [];
  let empty = 0;
  let cached = 0;
  const total = entries.filter((entry) => entry?.name && entry?.url).length;
  let processed = 0;
  let consecutiveFailures = 0;

  if (isCancelled()) throw new Error("EXPORT_CANCELLED");
  await pruneImageCache(options, reportProgress);
  if (total) reportProgress(`开始下载 ZIP 图片：0 / ${total}`);
  for (const entry of entries) {
    if (isCancelled()) throw new Error("EXPORT_CANCELLED");
    if (!entry?.name || !entry?.url) continue;
    try {
      const image = await loadImageBytes(entry.url, entry.cacheKey, options);
      if (!image || image.empty) {
        empty += 1;
      } else {
        cached += image.fromCache ? 1 : 0;
        zipEntries.push({
          name: sanitizeZipPath(entry.name),
          bytes: image.bytes
        });
      }
      consecutiveFailures = 0;
    } catch (error) {
      errors.push(`${entry.name}: ${error.message || error}`);
      consecutiveFailures += 1;
    }

    processed += 1;
    if (shouldReportProgress(processed, total)) {
      reportProgress(`下载 ZIP 图片：${processed} / ${total}，成功 ${zipEntries.length}，缓存 ${cached}，空 ${empty}，失败 ${errors.length}`);
    }
    assertImageFailures(consecutiveFailures, options);
    await throttleImageRequest(processed, total, options, reportProgress, "ZIP 图片", isCancelled);
  }

  if (!zipEntries.length) {
    if (empty > 0) {
      reportProgress(`图片 ZIP 没有可写入的有效图片：空 ${empty}，失败 ${errors.length}`);
      return {
        downloadId: null,
        count: 0,
        failed: errors.length,
        empty,
        cached,
        errors: errors.slice(0, 10)
      };
    }
    throw new Error(errors.length ? `图片下载失败：${errors[0]}` : "没有可打包的图片");
  }

  reportProgress(`正在生成图片 ZIP：${zipEntries.length} 张图片`);
  const zipBytes = createZip(zipEntries);
  const url = bytesToDataUrl(zipBytes, "application/zip");

  reportProgress("正在保存图片 ZIP...");
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });

  return {
    downloadId,
    count: zipEntries.length,
    failed: errors.length,
    empty,
    cached,
    errors: errors.slice(0, 10)
  };
}

async function downloadXlsx(filename, rows, columns, imagePreviews, options, reportProgress = () => {}, isCancelled = () => false) {
  const imageEntries = [];
  const previewColumnIndex = columns.findIndex(([key]) => key === "productImagePreview");
  const total = imagePreviews.filter((preview) => Number.isInteger(preview?.rowIndex) && preview?.url).length;
  let processed = 0;
  let consecutiveFailures = 0;
  let empty = 0;
  let cached = 0;

  if (isCancelled()) throw new Error("EXPORT_CANCELLED");
  await pruneImageCache(options, reportProgress);
  if (total) reportProgress(`开始下载 Excel 预览图：0 / ${total}`);
  for (const preview of imagePreviews) {
    if (isCancelled()) throw new Error("EXPORT_CANCELLED");
    if (!Number.isInteger(preview?.rowIndex) || !preview?.url) continue;
    try {
      const image = await loadImageBytes(preview.url, preview.cacheKey, options);
      if (!image || image.empty) {
        empty += 1;
      } else {
        cached += image.fromCache ? 1 : 0;
        imageEntries.push({
          rowIndex: preview.rowIndex,
          mediaIndex: imageEntries.length + 1,
          extension: image.extension,
          bytes: image.bytes
        });
      }
      consecutiveFailures = 0;
    } catch (_error) {
      consecutiveFailures += 1;
      // Keep the row in Excel even if its preview image cannot be fetched.
    }

    processed += 1;
    if (shouldReportProgress(processed, total)) {
      reportProgress(`下载 Excel 预览图：${processed} / ${total}，成功 ${imageEntries.length}，缓存 ${cached}，空 ${empty}`);
    }
    assertImageFailures(consecutiveFailures, options);
    await throttleImageRequest(processed, total, options, reportProgress, "Excel 预览图", isCancelled);
  }

  reportProgress(`正在生成 Excel：${rows.length} 行，嵌入 ${imageEntries.length} 张图片`);
  const xlsxBytes = createXlsx({
    rows,
    columns,
    imageEntries,
    previewColumnIndex
  });
  const url = bytesToDataUrl(xlsxBytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  reportProgress("正在保存 Excel 文件...");
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });

  return {
    downloadId,
    imageCount: imageEntries.length,
    emptyImageCount: empty,
    cachedImageCount: cached
  };
}

function shouldReportProgress(done, total) {
  return done === 1 || done === total || done % 10 === 0;
}

async function loadImageBytes(url, cacheKey, options = normalizeImageOptions()) {
  const primaryKey = cacheKey || url;
  const cached = options.cacheEnabled ? await getCachedImage(primaryKey) : null;
  if (cached?.bytes?.length) {
    return {
      bytes: cached.bytes,
      extension: cached.extension || imageExtensionFromUrl(url),
      fromCache: true,
      empty: false
    };
  }
  const legacyCached = options.cacheEnabled && primaryKey !== url ? await getCachedImage(url) : null;
  if (legacyCached?.bytes?.length) {
    await putCachedImage(primaryKey, legacyCached.bytes, legacyCached.extension || imageExtensionFromUrl(url), url);
    return {
      bytes: legacyCached.bytes,
      extension: legacyCached.extension || imageExtensionFromUrl(url),
      fromCache: true,
      empty: false
    };
  }

  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    return {
      bytes,
      extension: imageExtensionFromUrl(url),
      fromCache: false,
      empty: true
    };
  }

  const extension = imageExtensionFromResponse(url, response);
  if (options.cacheEnabled) {
    await putCachedImage(primaryKey, bytes, extension, url);
  }
  return {
    bytes,
    extension,
    fromCache: false,
    empty: false
  };
}

function imageExtensionFromResponse(url, response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("bmp")) return "bmp";
  return imageExtensionFromUrl(url);
}

async function openImageCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open("jd-order-exporter-cache", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "url" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function getCachedImage(key) {
  try {
    const db = await openImageCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readonly");
      const request = tx.objectStore("images").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  } catch (_error) {
    return null;
  }
}

async function putCachedImage(key, bytes, extension, sourceUrl = "") {
  try {
    const db = await openImageCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").put({
        url: key,
        sourceUrl,
        bytes,
        extension,
        updatedAt: Date.now()
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("IndexedDB write failed"));
      };
    });
  } catch (_error) {
    // Cache is best-effort; exporting should continue if persistence fails.
  }
}

async function pruneImageCache(options, reportProgress = () => {}) {
  if (!options.cacheEnabled || options.cacheTtlDays <= 0) return;
  const cutoff = Date.now() - options.cacheTtlDays * 24 * 60 * 60 * 1000;
  const deleted = await deleteImageCacheWhere((record) => Number(record.updatedAt || 0) < cutoff);
  if (deleted > 0) {
    reportProgress(`已清理过期图片缓存：${deleted} 条`);
  }
}

async function clearImageCache() {
  const deleted = await deleteImageCacheWhere(() => true);
  return { deleted };
}

async function deleteImageCacheWhere(shouldDelete) {
  const db = await openImageCacheDb();
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const tx = db.transaction("images", "readwrite");
    const store = tx.objectStore("images");
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (shouldDelete(cursor.value)) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed"));
    tx.oncomplete = () => {
      db.close();
      resolve(deleted);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("IndexedDB delete failed"));
    };
  });
}

function createXlsx({ rows, columns, imageEntries, previewColumnIndex }) {
  const files = [
    { name: "[Content_Types].xml", bytes: textBytes(xlsxContentTypes(imageEntries)) },
    { name: "_rels/.rels", bytes: textBytes(rootRelsXml()) },
    { name: "docProps/app.xml", bytes: textBytes(appPropsXml()) },
    { name: "docProps/core.xml", bytes: textBytes(corePropsXml()) },
    { name: "xl/workbook.xml", bytes: textBytes(workbookXml()) },
    { name: "xl/_rels/workbook.xml.rels", bytes: textBytes(workbookRelsXml()) },
    { name: "xl/styles.xml", bytes: textBytes(stylesXml()) },
    { name: "xl/worksheets/sheet1.xml", bytes: textBytes(sheetXml(rows, columns, imageEntries.length > 0)) }
  ];

  if (imageEntries.length) {
    files.push(
      { name: "xl/worksheets/_rels/sheet1.xml.rels", bytes: textBytes(sheetRelsXml()) },
      { name: "xl/drawings/drawing1.xml", bytes: textBytes(drawingXml(imageEntries, previewColumnIndex)) },
      { name: "xl/drawings/_rels/drawing1.xml.rels", bytes: textBytes(drawingRelsXml(imageEntries)) }
    );

    for (const image of imageEntries) {
      files.push({
        name: `xl/media/image${image.mediaIndex}.${image.extension}`,
        bytes: image.bytes
      });
    }
  }

  return createZip(files);
}

function xlsxContentTypes(imageEntries) {
  const imageTypes = [...new Set(imageEntries.map((image) => image.extension))]
    .map((extension) => `<Default Extension="${xmlEscape(extension)}" ContentType="${imageContentType(extension)}"/>`)
    .join("");
  const drawingOverride = imageEntries.length
    ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${imageTypes}
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
${drawingOverride}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="JD Orders" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function appPropsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>JD Order Exporter</Application>
</Properties>`;
}

function corePropsXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>JD Order Exporter</dc:creator>
<cp:lastModifiedBy>JD Order Exporter</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`;
}

function sheetXml(rows, columns, hasImages) {
  const columnXml = columns.map(([key], index) => {
    const width = columnWidth(key, hasImages);
    const col = index + 1;
    return `<col min="${col}" max="${col}" width="${width}" customWidth="1"/>`;
  }).join("");
  const headerCells = columns.map(([, label], index) => inlineCell(index, 1, label, 1)).join("");
  const bodyRows = rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const height = hasImages ? ' ht="72" customHeight="1"' : ' ht="42" customHeight="1"';
    const cells = columns.map(([key], columnIndex) => {
      const value = key === "productImagePreview" ? "" : row[key];
      return inlineCell(columnIndex, excelRow, value, cellStyleForKey(key));
    }).join("");
    return `<row r="${excelRow}"${height}>${cells}</row>`;
  }).join("");
  const drawing = hasImages ? '<drawing r:id="rId1"/>' : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<cols>${columnXml}</cols>
<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>
${drawing}
</worksheet>`;
}

function sheetRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
}

function drawingXml(imageEntries, previewColumnIndex) {
  const anchors = imageEntries.map((image) => {
    const row = image.rowIndex + 1;
    const col = previewColumnIndex;
    return `<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>95250</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${col + 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${image.mediaIndex}" name="Product Image ${image.mediaIndex}"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId${image.mediaIndex}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:twoCellAnchor>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`;
}

function drawingRelsXml(imageEntries) {
  const rels = imageEntries.map((image) => `<Relationship Id="rId${image.mediaIndex}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${image.mediaIndex}.${image.extension}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function inlineCell(columnIndex, rowNumber, value, styleId = 0) {
  const ref = `${columnName(columnIndex)}${rowNumber}`;
  const text = value == null ? "" : String(value);
  const style = styleId ? ` s="${styleId}"` : "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`;
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function columnWidth(key, hasImages) {
  const widths = {
    rangeLabel: 10,
    page: 6,
    sequence: 8,
    orderTime: 20,
    orderNumber: 18,
    productImagePreview: hasImages ? 16 : 10,
    productSummary: 58,
    productCount: 8,
    quantityTotal: 10,
    amount: 10,
    paymentMethod: 12,
    status: 12,
    receiver: 14,
    detailUrl: 34,
    productImageUrls: 46
  };
  return widths[key] || 16;
}

function cellStyleForKey(key) {
  return new Set(["productSummary", "detailUrl", "productImageUrls"]).has(key) ? 2 : 0;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function imageExtensionFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\.(jpg|jpeg|png|gif|bmp)(?:$|[!._-])/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch (_error) {
    return "jpg";
  }
}

function imageContentType(extension) {
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "bmp") return "image/bmp";
  return "image/jpeg";
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function sanitizeZipPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[:*?"<>|]+/g, "-"))
    .join("/") || "image.jpg";
}

function createZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;
  const modTime = dosTime(new Date());
  const modDate = dosDate(new Date());

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, modTime, true);
    localView.setUint16(12, modDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, entry.bytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, modTime, true);
    centralView.setUint16(14, modDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);

    offset += localHeader.length + entry.bytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...chunks, ...centralChunks, endHeader]);
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function bytesToDataUrl(bytes, mimeType) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function dosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function dosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
