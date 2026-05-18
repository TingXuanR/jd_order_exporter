(function () {
  "use strict";

  if (window.__jdAfsExporterLoaded) return;
  window.__jdAfsExporterLoaded = true;

  const PANEL_ID = "jd-afs-exporter";
  const MAX_PAGES = 300;
  const DETAIL_CONCURRENCY = 3;
  const REFUND_DONE_WORDS = [
    "已退款",
    "退款成功",
    "退款完成",
    "退款已完成",
    "已完成退款",
    "退款状态完成",
    "退款状态成功",
    "已退回",
    "已原路退回",
    "原路退回",
    "已到账"
  ];
  const REFUND_PENDING_WORDS = [
    "待退款",
    "退款中",
    "退款处理中",
    "退款失败",
    "未退款",
    "无需退款",
    "不予退款"
  ];

  const state = {
    running: false,
    stopRequested: false,
    records: [],
    seenKeys: new Set()
  };

  function textOf(node) {
    return (node && node.textContent ? node.textContent : "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n\s*/g, "\n")
      .trim();
  }

  function compactText(node) {
    return textOf(node).replace(/\s+/g, " ").trim();
  }

  function absoluteUrl(raw, baseUrl) {
    if (!raw) return "";
    try {
      return new URL(raw, baseUrl || location.href).href;
    } catch (_) {
      return "";
    }
  }

  function sameHostUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === location.hostname ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function uniq(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function chineseScore(text) {
    return (text.match(/[\u4e00-\u9fff]/g) || []).length;
  }

  function mojibakeScore(text) {
    return (text.match(/�|锟斤拷|Ã|Â|ä|å|æ|ç/g) || []).length;
  }

  function decodeHtmlBytes(bytes, contentType) {
    const headerCharset = (contentType || "").match(/charset=([^;\s]+)/i);
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 4096));
    const metaCharset = head.match(/<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i);
    const declared = (headerCharset && headerCharset[1]) || (metaCharset && metaCharset[1]) || "";
    const label = /gb2312|gbk|gb18030/i.test(declared) ? "gb18030" : declared || "utf-8";

    let decoded = new TextDecoder(label, { fatal: false }).decode(bytes);
    if (!/gb2312|gbk|gb18030/i.test(label)) {
      const gbDecoded = new TextDecoder("gb18030", { fatal: false }).decode(bytes);
      if (
        mojibakeScore(decoded) > mojibakeScore(gbDecoded) ||
        (chineseScore(gbDecoded) > chineseScore(decoded) * 2 && mojibakeScore(gbDecoded) <= 2)
      ) {
        decoded = gbDecoded;
      }
    }
    return decoded;
  }

  function matchFirst(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1] || match[0];
    }
    return "";
  }

  function normalizeDate(value) {
    return (value || "").replace(/[年月]/g, "-").replace(/[日]/g, "").trim();
  }

  function inferServiceType(text) {
    const serviceInfo = extractServiceInfo(text);
    if (serviceInfo.serviceType) return serviceInfo.serviceType;
    if (/退款总额|退款方式|预计退款至/.test(text)) return "退货";
    const types = ["退货", "换货", "维修", "返修", "退款", "补发", "价格保护"];
    return types.find((type) => new RegExp(`(?:处理方式|服务类型|售后类型|申请类型).{0,20}${type}`).test(text)) || "";
  }

  function inferStatus(text) {
    const statuses = [
      "已完成",
      "已取消",
      "已关闭",
      "待审核",
      "审核中",
      "审核通过",
      "审核不通过",
      "待寄回",
      "待收货",
      "处理中",
      "退款成功",
      "已退款",
      "退款中",
      "已驳回"
    ];
    return statuses.find((status) => text.includes(status)) || "";
  }

  function extractAmount(text) {
    const amount = matchFirst(text, [
      /(?:退款总额|退款金额|退回金额|实退金额|返还金额|已退金额)[^￥¥0-9]{0,20}[￥¥]\s*([0-9]+(?:\.[0-9]{1,2})?)/,
      /(?:退款总额|退款金额|退回金额|实退金额|返还金额|已退金额)[^0-9]{0,20}([0-9]+(?:\.[0-9]{1,2})?)/
    ]);
    return amount || "";
  }

  function normalizeServiceType(value) {
    if (!value) return "";
    if (value.includes("退货")) return "退货";
    if (value.includes("换货")) return "换货";
    if (value.includes("维修") || value.includes("返修")) return "维修";
    if (value.includes("退款")) return "退款";
    return value;
  }

  function extractServiceInfo(text) {
    const normalized = text.replace(/\s+/g, " ");
    const finalMethod = matchFirst(normalized, [
      /最终处理方式为[“"']?([^“”"',，。；\s]+)[”"']?/,
      /商品处理方式.{0,80}?最终处理方式为[“"']?([^“”"',，。；\s]+)[”"']?/
    ]);
    const expectedMethod = matchFirst(normalized, [
      /客户期望处理方式为[“"']?([^“”"',，。；\s]+)[”"']?/,
      /商品处理方式.{0,80}?处理方式为[“"']?([^“”"',，。；\s]+)[”"']?/
    ]);
    const handlingMethod = finalMethod || expectedMethod || "";
    const refundTotal = matchFirst(normalized, [
      /退款总额[^￥¥0-9]{0,20}[￥¥]\s*([0-9]+(?:\.[0-9]{1,2})?)/,
      /退款总额[^0-9]{0,20}([0-9]+(?:\.[0-9]{1,2})?)/
    ]);
    const arrivalTime = matchFirst(normalized, [
      /到账时间\s*([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}(?:日)?(?:\s+[0-9:]{4,8})?)/
    ]);
    const serviceType = normalizeServiceType(handlingMethod) || (refundTotal ? "退货" : "");
    const refundIndex = normalized.indexOf("退款总额");

    return {
      serviceType,
      handlingMethod,
      refundTotal,
      arrivalTime: normalizeDate(arrivalTime),
      refunded: Boolean(refundTotal && arrivalTime),
      refundEvidence:
        refundIndex >= 0
          ? normalized.slice(Math.max(0, refundIndex - 80), Math.min(normalized.length, refundIndex + 220))
          : ""
    };
  }

  function findDateTimes(text) {
    return text.match(/[0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}(?:日)?\s+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?/g) || [];
  }

  function sortableDateTime(value) {
    const normalized = normalizeDate(value).replace(/\//g, "-");
    const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return Number.POSITIVE_INFINITY;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second || 0)
    ).getTime();
  }

  function extractAuditApplyTime(text) {
    const auditIndex = text.indexOf("审核环节");
    if (auditIndex < 0) return "";
    const tail = text.slice(auditIndex);
    const nextSection = tail.slice(4).search(/(?:取件|收货|处理|检测|退款|完成|配送|发货|服务|商品).{0,8}环节/);
    const section = nextSection >= 0 ? tail.slice(0, nextSection + 4) : tail.slice(0, 5000);
    const times = findDateTimes(section);
    if (!times.length) return "";
    return normalizeDate(times.sort((a, b) => sortableDateTime(a) - sortableDateTime(b))[0]);
  }

  function extractAuditEndTime(text) {
    const auditIndex = text.indexOf("审核环节");
    if (auditIndex < 0) return "";
    const tail = text.slice(auditIndex);
    const nextSection = tail.slice(4).search(/(?:取件|收货|处理|检测|退款|完成|配送|发货|服务|商品).{0,8}环节/);
    const section = nextSection >= 0 ? tail.slice(0, nextSection + 4) : tail.slice(0, 5000);
    const times = findDateTimes(section);
    if (!times.length) return "";
    return normalizeDate(times[0]);
  }

  function detectRefund(text) {
    const normalizedText = text.replace(/\s+/g, "");
    const doneIndex = REFUND_DONE_WORDS
      .map((word) => ({ word, index: normalizedText.indexOf(word) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    const pendingIndex = REFUND_PENDING_WORDS
      .map((word) => ({ word, index: normalizedText.indexOf(word) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    const refundWindows = refundEvidenceWindows(text);
    const completedWindow = refundWindows.find((windowText) => {
      const compact = windowText.replace(/\s+/g, "");
      return (
        /退款|退回|返还|返款|原路/.test(compact) &&
        /完成|成功|到账|已处理|已受理|已退|退回/.test(compact) &&
        !/待退款|退款中|退款处理中|退款失败|未退款|无需退款|不予退款/.test(compact)
      );
    });

    const refunded = Boolean(doneIndex || completedWindow);
    const refundStatus = doneIndex
      ? doneIndex.word
      : completedWindow
        ? "退款信息已完成"
        : pendingIndex
          ? pendingIndex.word
          : "";
    const index = doneIndex ? doneIndex.index : pendingIndex ? pendingIndex.index : -1;
    const evidence =
      completedWindow ||
      (index >= 0
        ? text.slice(Math.max(0, index - 35), Math.min(text.length, index + 55))
        : "");

    return {
      refunded,
      refundStatus,
      refundEvidence: evidence,
      refundAmount: extractAmount(text)
    };
  }

  function refundEvidenceWindows(text) {
    const anchors = [
      "退款明细",
      "退款信息",
      "退款详情",
      "退款金额",
      "退款总额",
      "退款状态",
      "退款单号",
      "到账时间",
      "返款",
      "退回"
    ];
    return anchors
      .map((anchor) => text.indexOf(anchor))
      .filter((index) => index >= 0)
      .map((index) => text.slice(Math.max(0, index - 80), Math.min(text.length, index + 420)));
  }

  function extractUrlFromJavascript(anchor, baseUrl) {
    const attrs = Array.from(anchor.attributes || []).map((attr) => attr.value).join(" ");
    const code = `${attrs} ${anchor.getAttribute("onclick") || ""} ${
      anchor.getAttribute("href") || ""
    }`;
    const quoted = code.match(/['"]([^'"]*(?:afs|repair)[^'"]*)['"]/i);
    if (quoted) return sameHostUrl(absoluteUrl(quoted[1], baseUrl));

    const serviceId = code.match(/(?:afsServiceId|serviceId|repairId|id)\D+(\d{6,})/i);
    if (serviceId) {
      return sameHostUrl(
        absoluteUrl(`/afs/detail/repairDetail.action?afsServiceId=${serviceId[1]}`, baseUrl)
      );
    }

    const label = compactText(anchor);
    const genericId = code.match(/\b(\d{6,})\b/);
    if (genericId && /查看|详情|进度|repair|detail/i.test(`${label} ${code}`)) {
      return sameHostUrl(
        absoluteUrl(`/afs/detail/repairDetail.action?afsServiceId=${genericId[1]}`, baseUrl)
      );
    }
    return "";
  }

  function extractDetailUrl(element, baseUrl) {
    const anchors = Array.from(element.querySelectorAll("a"));
    const scored = anchors
      .map((anchor) => {
        const label = compactText(anchor);
        const href = anchor.getAttribute("href") || "";
        let url = "";
        if (href && !/^javascript:/i.test(href) && href !== "#") {
          url = sameHostUrl(absoluteUrl(href, baseUrl));
        }
        if (!url) url = extractUrlFromJavascript(anchor, baseUrl);
        if (!url) return null;

        let score = 0;
        if (/查看|详情|进度|服务单信息|处理记录/.test(label)) score += 8;
        if (/afs|repair/i.test(url)) score += 4;
        if (/apply|cancel|delete/i.test(url)) score -= 10;
        return { url, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return scored.length && scored[0].score > 0 ? scored[0].url : "";
  }

  function extractIds(text, url) {
    const serviceIdFromUrl = matchFirst(url || "", [
      /(?:afsServiceId|serviceId|repairId|repairNo|applyId|id)=([0-9]+)/i
    ]);
    const serviceId =
      serviceIdFromUrl ||
      matchFirst(text, [
        /服务单号[:：\s]*([0-9]{6,})/,
        /售后单号[:：\s]*([0-9]{6,})/,
        /返修单号[:：\s]*([0-9]{6,})/
      ]);
    const orderId = matchFirst(text, [
      /订单号[:：\s]*([0-9]{8,})/,
      /订单编号[:：\s]*([0-9]{8,})/
    ]);
    return { serviceId, orderId };
  }

  function candidateDetailUrls(record) {
    const urls = [record.detailUrl];
    if (record.serviceId) {
      [
        `/afs/detail/repairDetail.action?afsServiceId=${record.serviceId}`,
        `/afs/detail/repairDetail.action?repairId=${record.serviceId}`,
        `/afs/detail/repairDetail.action?serviceId=${record.serviceId}`,
        `/afs/repair/repairDetail.action?afsServiceId=${record.serviceId}`,
        `/repair/detail.action?repairId=${record.serviceId}`
      ].forEach((path) => urls.push(absoluteUrl(path, location.href)));
    }
    if (record.orderId) {
      [
        `/afs/detail/repairDetail.action?orderId=${record.orderId}`,
        `/afs/list/refundList.action?orderId=${record.orderId}`,
        `/afs/refund/refundDetail.action?orderId=${record.orderId}`
      ].forEach((path) => urls.push(absoluteUrl(path, location.href)));
    }
    return uniq(urls.map(sameHostUrl));
  }

  function extractProductName(element) {
    const imageTitle = Array.from(element.querySelectorAll("img"))
      .map((img) => img.getAttribute("alt") || img.getAttribute("title") || "")
      .find((value) => value && value.length > 2);
    if (imageTitle) return imageTitle.trim();

    const linkTexts = Array.from(element.querySelectorAll("a"))
      .map((anchor) => compactText(anchor))
      .filter((value) => value.length >= 4 && !/查看|详情|申请|进度|评价|取消/.test(value))
      .sort((a, b) => b.length - a.length);
    return linkTexts[0] || "";
  }

  function isLikelyRecordText(text) {
    if (!text || text.length < 20) return false;
    if (/服务单号|售后单号|返修单号/.test(text)) return true;
    return /订单号|订单编号/.test(text) && /退货|换货|维修|返修|退款|售后/.test(text);
  }

  function tableCells(row) {
    return Array.from(row.children || []).filter((cell) => /^(TD|TH)$/i.test(cell.tagName));
  }

  function isLikelyTableRecordRow(row) {
    const cells = tableCells(row);
    if (cells.length < 5 || cells.some((cell) => cell.tagName === "TH")) return false;

    const text = compactText(row);
    const numberCount = (text.match(/\b\d{8,}\b/g) || []).length;
    const hasDate = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(text);
    const hasAction = /查看|详情|进度/.test(text) || Boolean(extractDetailUrl(row, location.href));
    return numberCount >= 2 && hasDate && hasAction;
  }

  function getTableHeaders(row) {
    const table = row.closest("table");
    if (!table) return [];

    const headerRow =
      table.querySelector("thead tr") ||
      Array.from(table.querySelectorAll("tr")).find((candidate) =>
        /返修|退换货|服务单|订单|商品|申请时间|状态|操作/.test(compactText(candidate))
      );
    return headerRow ? tableCells(headerRow).map((cell) => compactText(cell)) : [];
  }

  function findColumn(headers, fallbackIndex, patterns) {
    const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return index >= 0 ? index : fallbackIndex;
  }

  function cellText(cells, index) {
    return index >= 0 && cells[index] ? compactText(cells[index]) : "";
  }

  function firstLongNumber(text, minLength) {
    const pattern = new RegExp(`\\b\\d{${minLength || 8},}\\b`);
    const match = text.match(pattern);
    return match ? match[0] : "";
  }

  function smallestRecordContainers(doc) {
    const tableRows = Array.from(doc.querySelectorAll("tbody tr, table tr")).filter((row) => {
      const text = compactText(row);
      return isLikelyTableRecordRow(row) || isLikelyRecordText(text);
    });
    if (tableRows.length) return tableRows;

    const selectors = [
      "li",
      ".item",
      ".repair-item",
      ".service-item",
      ".order-item",
      "[class*='repair']",
      "[class*='afs']",
      "[class*='service']"
    ];
    const candidates = Array.from(doc.querySelectorAll(selectors.join(",")))
      .filter((element) => {
        const text = compactText(element);
        return isLikelyRecordText(text) && text.length < 3500;
      })
      .sort((a, b) => compactText(a).length - compactText(b).length);

    const selected = [];
    for (const candidate of candidates) {
      if (!selected.some((existing) => existing.contains(candidate))) {
        selected.push(candidate);
      }
    }
    return selected;
  }

  function extractRecord(element, pageUrl) {
    if (element.matches && element.matches("tr") && isLikelyTableRecordRow(element)) {
      return extractTableRecord(element, pageUrl);
    }

    const text = compactText(element);
    const detailUrl = extractDetailUrl(element, pageUrl);
    const ids = extractIds(text, detailUrl);
    const applyTime = normalizeDate(
      matchFirst(text, [
        /申请时间[:：\s]*([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}(?:日)?(?:\s+[0-9:]{4,8})?)/,
        /([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}(?:日)?(?:\s+[0-9:]{4,8})?)/
      ])
    );
    const refund = detectRefund(text);

    return {
      serviceId: ids.serviceId,
      orderId: ids.orderId,
      applyTime,
      endTime: "",
      productName: extractProductName(element),
      serviceType: inferServiceType(text),
      handlingMethod: "",
      listStatus: inferStatus(text),
      refunded: refund.refunded,
      refundStatus: refund.refundStatus,
      refundAmount: refund.refundAmount,
      refundEvidence: refund.refundEvidence,
      detailUrl,
      sourcePage: pageUrl
    };
  }

  function extractTableRecord(row, pageUrl) {
    const cells = tableCells(row);
    const headers = getTableHeaders(row);
    const serviceIndex = findColumn(headers, 0, [/返修/, /退换货/, /服务单/, /售后/]);
    const orderIndex = findColumn(headers, 1, [/订单/]);
    const productIndex = findColumn(headers, 2, [/商品/]);
    const timeIndex = findColumn(headers, 3, [/申请时间/, /时间/]);
    const statusIndex = findColumn(headers, 4, [/状态/]);
    const text = compactText(row);
    const detailUrl = extractDetailUrl(row, pageUrl);
    const refund = detectRefund(text);
    const serviceText = cellText(cells, serviceIndex);
    const orderText = cellText(cells, orderIndex);

    return {
      serviceId: firstLongNumber(serviceText, 6) || extractIds(text, detailUrl).serviceId,
      orderId: firstLongNumber(orderText, 8) || extractIds(text, detailUrl).orderId,
      applyTime: normalizeDate(
        matchFirst(cellText(cells, timeIndex) || text, [
          /([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}(?:日)?(?:\s+[0-9:]{4,8})?)/
        ])
      ),
      endTime: "",
      productName: cellText(cells, productIndex) || extractProductName(row),
      serviceType: "",
      handlingMethod: "",
      listStatus: cellText(cells, statusIndex) || inferStatus(text),
      refunded: refund.refunded,
      refundStatus: refund.refundStatus,
      refundAmount: refund.refundAmount,
      refundEvidence: refund.refundEvidence,
      detailUrl,
      sourcePage: pageUrl
    };
  }

  function recordKey(record) {
    return (
      record.serviceId ||
      record.detailUrl ||
      [record.orderId, record.applyTime, record.productName].filter(Boolean).join("|")
    );
  }

  function extractRecordsFromDocument(doc, pageUrl) {
    return smallestRecordContainers(doc)
      .map((element) => extractRecord(element, pageUrl))
      .filter((record) => recordKey(record));
  }

  function parsePageNumberFromJavascript(anchor) {
    const dataPage =
      anchor.getAttribute("data-page") ||
      anchor.getAttribute("page") ||
      anchor.getAttribute("page-no") ||
      anchor.getAttribute("data-page-no") ||
      "";
    if (/^[0-9]{1,5}$/.test(dataPage)) return Number(dataPage);

    const attrs = Array.from(anchor.attributes || []).map((attr) => attr.value).join(" ");
    const code = `${attrs} ${anchor.getAttribute("onclick") || ""} ${
      anchor.getAttribute("href") || ""
    }`;
    const match = code.match(/(?:page|goPage|turnPage|toPage)\D+([0-9]{1,5})/i);
    return match ? Number(match[1]) : 0;
  }

  function currentPageNumber(doc, pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      for (const key of ["page", "pageNo", "pageNum", "currentPage", "currentPageNo"]) {
        const value = parsed.searchParams.get(key);
        if (/^[0-9]{1,5}$/.test(value || "")) return Number(value);
      }
    } catch (_) {
      // Fall through to DOM inspection.
    }

    const current = Array.from(doc.querySelectorAll("a, span, em, strong")).find((element) => {
      const label = compactText(element);
      const className = element.className || "";
      return /^[0-9]{1,5}$/.test(label) && /current|curr|active|on/.test(className);
    });
    return current ? Number(compactText(current)) : 0;
  }

  function withPageParam(url, pageNumber) {
    try {
      const parsed = new URL(url);
      const currentParams = ["page", "pageNo", "pageNum", "currentPage", "currentPageNo"];
      const existing = currentParams.find((param) => parsed.searchParams.has(param));
      parsed.searchParams.set(existing || "page", String(pageNumber));
      return parsed.href;
    } catch (_) {
      return "";
    }
  }

  function findNextPageUrl(doc, pageUrl) {
    const anchors = Array.from(doc.querySelectorAll("a"));
    const candidates = anchors.filter((anchor) => {
      const label = compactText(anchor);
      const className = anchor.className || "";
      const parentClassName = anchor.parentElement ? anchor.parentElement.className || "" : "";
      const disabled = /disabled|disable|current|curr|on/.test(`${className} ${parentClassName}`);
      return !disabled && (/下一页|下页|next/i.test(label) || /next|p-next/i.test(className));
    });

    for (const anchor of candidates) {
      const href = anchor.getAttribute("href") || "";
      if (href && !/^javascript:/i.test(href) && href !== "#") {
        const url = sameHostUrl(absoluteUrl(href, pageUrl));
        if (url && url !== pageUrl) return url;
      }

      const pageNumber = parsePageNumberFromJavascript(anchor);
      if (pageNumber) {
        const url = withPageParam(pageUrl, pageNumber);
        if (url && url !== pageUrl) return url;
      }
    }

    const currentPage = currentPageNumber(doc, pageUrl);
    if (currentPage) {
      const numericNext = anchors.find((anchor) => compactText(anchor) === String(currentPage + 1));
      if (numericNext) {
        const href = numericNext.getAttribute("href") || "";
        if (href && !/^javascript:/i.test(href) && href !== "#") {
          const url = sameHostUrl(absoluteUrl(href, pageUrl));
          if (url && url !== pageUrl) return url;
        }
        const url = withPageParam(pageUrl, currentPage + 1);
        if (url && url !== pageUrl) return url;
      }
    }
    return "";
  }

  async function fetchDocument(url) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const html = decodeHtmlBytes(bytes, response.headers.get("content-type"));
    return parseHtml(html);
  }

  function clickMoreInDocument(doc) {
    const candidates = Array.from(doc.querySelectorAll("a, button, span, div"))
      .filter((element) => /查看更多|更多|展开/.test(compactText(element)))
      .filter((element) => {
        const style = doc.defaultView ? doc.defaultView.getComputedStyle(element) : null;
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      });

    candidates.forEach((element) => {
      try {
        element.click();
      } catch (_) {
        // Some legacy nodes are not clickable through synthetic events; ignore.
      }
    });
    return candidates.length;
  }

  async function fetchRenderedDetail(url) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      let settled = false;
      const cleanup = () => {
        iframe.remove();
      };
      const finish = async () => {
        if (settled) return;
        try {
          const doc = iframe.contentDocument;
          if (!doc) throw new Error("无法读取详情页");
          for (let i = 0; i < 4; i += 1) {
            const clicked = clickMoreInDocument(doc);
            if (!clicked) break;
            await sleep(250);
          }
          settled = true;
          const text = compactText(doc.body || doc.documentElement);
          cleanup();
          resolve({ doc, text });
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };

      iframe.addEventListener("load", () => {
        setTimeout(finish, 500);
      });
      iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-10000px;top:-10000px;border:0;";
      iframe.src = url;
      document.documentElement.appendChild(iframe);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("详情页加载超时"));
        }
      }, 10000);
    });
  }

  async function readDetail(url) {
    try {
      const rendered = await fetchRenderedDetail(url);
      return rendered;
    } catch (_) {
      const doc = await fetchDocument(url);
      return { doc, text: compactText(doc.body || doc.documentElement) };
    }
  }

  function mergeRecord(record) {
    const key = recordKey(record);
    if (!key || state.seenKeys.has(key)) return false;
    state.seenKeys.add(key);
    state.records.push(record);
    return true;
  }

  async function collectListPages(currentOnly, pageRange) {
    let pageUrl = location.href;
    let doc = document;
    const seenPages = new Set();
    let pageCount = 0;

    while (pageUrl && !seenPages.has(pageUrl) && pageCount < MAX_PAGES) {
      if (state.stopRequested) break;
      seenPages.add(pageUrl);
      pageCount += 1;

      const inRange = currentOnly || (pageCount >= pageRange.from && pageCount <= pageRange.to);
      const records = inRange ? extractRecordsFromDocument(doc, pageUrl) : [];
      if (inRange) records.forEach(mergeRecord);
      updateStatus(
        `列表页 ${pageCount}${inRange ? "" : "（跳过）"}：累计 ${state.records.length} 条\n正在查找下一页...`,
        Math.min(45, pageCount * 4)
      );

      if (currentOnly) break;
      if (pageCount >= pageRange.to) break;
      const nextUrl = findNextPageUrl(doc, pageUrl);
      if (!nextUrl || seenPages.has(nextUrl)) break;

      await sleep(350);
      pageUrl = nextUrl;
      doc = await fetchDocument(pageUrl);
    }

    return pageCount;
  }

  function getPageRange(currentOnly) {
    if (currentOnly) return { from: 1, to: 1 };
    const panel = document.getElementById(PANEL_ID);
    const fromInput = panel ? panel.querySelector("[data-role='page-from']") : null;
    const toInput = panel ? panel.querySelector("[data-role='page-to']") : null;
    const from = Math.max(1, Number(fromInput && fromInput.value ? fromInput.value : 1) || 1);
    const toRaw = Number(toInput && toInput.value ? toInput.value : MAX_PAGES);
    const to = Math.max(from, Number.isFinite(toRaw) && toRaw > 0 ? toRaw : MAX_PAGES);
    return { from, to: Math.min(to, MAX_PAGES) };
  }

  async function enrichRecordWithDetail(record, index, total) {
    const urls = candidateDetailUrls(record);
    if (!urls.length || state.stopRequested) return record;
    const errors = [];
    try {
      for (const url of urls) {
        if (state.stopRequested) break;
        try {
          const detail = await readDetail(url);
          const text = detail.text;
          if (!/返修|退换货|售后|退款|退回|服务单|订单/.test(text)) {
            errors.push(`${url}: 非售后详情页`);
            continue;
          }

          const ids = extractIds(text, url);
          const refund = detectRefund(text);
          const serviceInfo = extractServiceInfo(text);
          const detailApplyTime = extractAuditApplyTime(text);
          const detailEndTime = extractAuditEndTime(text);
          const serviceType = serviceInfo.serviceType || record.serviceType;
          const isExchange = serviceType === "换货";
          const refundAmount = isExchange
            ? "0"
            : serviceInfo.refundTotal || refund.refundAmount || record.refundAmount || "";
          Object.assign(record, {
            serviceId: record.serviceId || ids.serviceId,
            orderId: record.orderId || ids.orderId,
            applyTime: detailApplyTime || record.applyTime,
            endTime: detailEndTime || record.endTime,
            serviceType,
            handlingMethod: serviceInfo.handlingMethod || record.handlingMethod,
            detailStatus: inferStatus(text) || record.detailStatus,
            refunded: isExchange ? false : refund.refunded || serviceInfo.refunded || record.refunded,
            refundStatus:
              isExchange
                ? ""
                : refund.refundStatus || (serviceInfo.refunded ? "退款总额已到账" : record.refundStatus),
            refundAmount,
            refundEvidence: refund.refundEvidence || serviceInfo.refundEvidence || record.refundEvidence,
            detailUrl: url,
            detailChecked: true
          });

          if (refund.refunded || serviceInfo.refunded || serviceInfo.serviceType) break;
        } catch (error) {
          errors.push(`${url}: ${error.message}`);
        }
      }

      if (!record.detailChecked) {
        record.detailChecked = false;
        record.detailError = errors.join(" | ");
      }
    } catch (error) {
      record.detailChecked = false;
      record.detailError = error.message;
    } finally {
      updateStatus(`详情页 ${index + 1}/${total}：已退款 ${countRefunded()} 条`, 45 + ((index + 1) / total) * 45);
    }
    return record;
  }

  async function enrichDetails() {
    const records = state.records.filter((record) => candidateDetailUrls(record).length);
    let cursor = 0;

    async function worker() {
      while (cursor < records.length && !state.stopRequested) {
        const index = cursor;
        cursor += 1;
        await enrichRecordWithDetail(records[index], index, records.length);
        await sleep(180);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, records.length) }, () => worker())
    );
  }

  function countRefunded() {
    return state.records.filter((record) => record.refunded).length;
  }

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(records) {
    const headers = [
      ["serviceId", "服务单号"],
      ["orderId", "订单号"],
      ["applyTime", "申请时间"],
      ["productName", "商品名称"],
      ["serviceType", "售后类型"],
      ["listStatus", "列表状态"],
      ["refundAmount", "退款金额"],
      ["endTime", "结束时间"],
      ["sourcePage", "来源列表页"]
    ];
    const rows = [headers.map((header) => csvEscape(header[1])).join(",")];
    for (const record of records) {
      rows.push(
        headers
          .map(([key]) => (key === "refunded" ? (record[key] ? "是" : "否") : record[key] || ""))
          .map(csvEscape)
          .join(",")
      );
    }
    return `\ufeff${rows.join("\n")}`;
  }

  function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function downloadBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportFiles() {
    const baseName = `jd-afs-${timestamp()}`;
    downloadBlob(`${baseName}.csv`, toCsv(state.records), "text/csv;charset=utf-8");
  }

  function setButtons(disabled) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelectorAll("[data-action='all'], [data-action='current']").forEach((button) => {
      button.disabled = disabled;
    });
    panel.querySelectorAll("[data-role='page-from'], [data-role='page-to']").forEach((input) => {
      input.disabled = disabled;
    });
    const stop = panel.querySelector("[data-action='stop']");
    if (stop) stop.disabled = !disabled;
  }

  function updateStatus(message, progress) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const status = panel.querySelector(".jd-afs-status");
    const bar = panel.querySelector(".jd-afs-progress > span");
    if (status) status.textContent = message;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, progress || 0))}%`;
  }

  async function runExport(currentOnly) {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.records = [];
    state.seenKeys = new Set();
    const pageRange = getPageRange(currentOnly);
    setButtons(true);

    try {
      updateStatus(
        currentOnly
          ? "开始读取当前售后列表页..."
          : `开始读取第 ${pageRange.from}-${pageRange.to === MAX_PAGES ? "末" : pageRange.to} 页...`,
        5
      );
      const pages = await collectListPages(currentOnly, pageRange);
      if (!state.records.length) {
        updateStatus(
          "没有识别到售后记录。请确认页数范围内有返修/退换货记录。",
          0
        );
        return;
      }

      updateStatus(`已读取 ${pages} 个列表页、${state.records.length} 条记录，开始查看详情...`, 45);
      await enrichDetails();

      updateStatus(
        `完成：${state.records.length} 条记录，已退款 ${countRefunded()} 条。\n正在导出 CSV...`,
        95
      );
      exportFiles();
      updateStatus(`已导出：${state.records.length} 条记录，已退款 ${countRefunded()} 条。`, 100);
    } catch (error) {
      updateStatus(`导出失败：${error.message}`, 0);
    } finally {
      state.running = false;
      setButtons(false);
    }
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="jd-afs-head">
        <div class="jd-afs-title">京东售后导出</div>
        <button class="jd-afs-close" data-action="close" title="隐藏">×</button>
      </div>
      <div class="jd-afs-body">
        <div class="jd-afs-status">打开“返修/退换货记录”后，点击导出即可在本地生成 CSV。</div>
        <div class="jd-afs-progress"><span></span></div>
        <div class="jd-afs-range">
          <span>页数</span>
          <input data-role="page-from" type="number" min="1" step="1" value="1" aria-label="起始页">
          <span>至</span>
          <input data-role="page-to" type="number" min="1" step="1" placeholder="末页" aria-label="结束页">
        </div>
        <div class="jd-afs-actions">
          <button class="jd-afs-btn jd-afs-btn-primary" data-action="all">导出范围</button>
          <button class="jd-afs-btn" data-action="current">当前页</button>
          <button class="jd-afs-btn" data-action="stop" disabled>停止</button>
          <button class="jd-afs-btn" data-action="csv">重下 CSV</button>
        </div>
        <div class="jd-afs-note">仅使用当前浏览器登录态读取 myjd.jd.com 页面；不会上传数据。</div>
      </div>
    `;
    panel.addEventListener("click", (event) => {
      const action = event.target && event.target.getAttribute("data-action");
      if (action === "close") panel.remove();
      if (action === "all") runExport(false);
      if (action === "current") runExport(true);
      if (action === "stop") {
        state.stopRequested = true;
        updateStatus("正在停止，已读取的数据会继续导出...", 90);
      }
      if (action === "csv") {
        if (state.records.length) exportFiles();
        else updateStatus("还没有可下载的结果，请先导出。", 0);
      }
    });
    document.documentElement.appendChild(panel);
  }

  createPanel();
})();
