(() => {
  const ROOT_ID = "jd-order-local-exporter";
  const CURRENT_YEAR = new Date().getFullYear();
  const MIN_START_YEAR = 2008;
  const DEFAULT_START_YEAR = 2017;
  const STATUS_OPTIONS = [
    { label: "全部状态", value: "all" },
    { label: "已完成", value: "completed" },
    { label: "已取消", value: "cancelled" }
  ];
  const ACTION_TEXTS = new Set([
    "申请售后",
    "卖了换钱",
    "联系客服",
    "联系卖家",
    "查看发票",
    "查看发票追评",
    "订单详情",
    "立即购买",
    "再次购买",
    "评价|晒单",
    "评价晒单",
    "追评",
    "删除",
    "查看拆分详情",
    "查看拆分详情>",
    "选购京东服务"
  ]);
  const NON_PRODUCT_HREF_PATTERNS = [
    "repair/",
    "ordersearchlist",
    "ivcLand",
    "myivc.jd.com",
    "club.jd.com",
    "javascript:void",
    "#none"
  ];

  document.getElementById(ROOT_ID)?.remove();

  let abortRequested = false;
  let isRunning = false;
  let currentJobId = "";

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "jd-exporter-root";
  root.innerHTML = `
    <button class="jd-exporter-fab" type="button">订单<br>导出</button>
    <section class="jd-exporter-panel jd-exporter-hidden" aria-label="京东订单本地导出">
      <div class="jd-exporter-header">
        <div>
          <h2 class="jd-exporter-title">京东订单本地导出</h2>
          <p class="jd-exporter-subtitle">本地读取当前登录态，导出 CSV / Excel，可选打包商品图片。</p>
        </div>
        <button class="jd-exporter-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="jd-exporter-body">
        <div class="jd-exporter-field">
          <label for="jd-exporter-range">日期范围</label>
          <select id="jd-exporter-range" class="jd-exporter-select">
            <option value="all">全量：${CURRENT_YEAR} + 历年</option>
            <option value="thisYear">${CURRENT_YEAR}</option>
            <option value="years" selected>指定年份区间</option>
          </select>
        </div>
        <div class="jd-exporter-grid">
          <div class="jd-exporter-field">
            <label for="jd-exporter-start-year">开始年份</label>
            <input id="jd-exporter-start-year" class="jd-exporter-input" type="number" min="${MIN_START_YEAR}" value="${DEFAULT_START_YEAR}">
          </div>
          <div class="jd-exporter-field">
            <label for="jd-exporter-end-year">结束年份</label>
            <input id="jd-exporter-end-year" class="jd-exporter-input" type="number" min="${MIN_START_YEAR}" value="${CURRENT_YEAR}">
          </div>
        </div>
        <div class="jd-exporter-field">
          <label for="jd-exporter-status">订单状态</label>
          <select id="jd-exporter-status" class="jd-exporter-select">
            ${STATUS_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join("")}
          </select>
        </div>
        <div class="jd-exporter-grid">
          <div class="jd-exporter-field">
            <label for="jd-exporter-delay">请求间隔 ms</label>
            <input id="jd-exporter-delay" class="jd-exporter-input" type="number" min="200" step="100" value="1000">
          </div>
          <div class="jd-exporter-field">
            <label for="jd-exporter-max-pages">每段最多页</label>
            <input id="jd-exporter-max-pages" class="jd-exporter-input" type="number" min="1" placeholder="不限">
          </div>
        </div>
        <div class="jd-exporter-field">
          <label for="jd-exporter-format">导出格式</label>
          <select id="jd-exporter-format" class="jd-exporter-select">
            <option value="csv">CSV</option>
            <option value="xlsx">Excel（可直接看图片）</option>
          </select>
        </div>
        <label class="jd-exporter-check">
          <input id="jd-exporter-split-years" type="checkbox">
          <span>按年份分别下载</span>
        </label>
        <label class="jd-exporter-check">
          <input id="jd-exporter-save-images" type="checkbox">
          <span>另存商品图片 ZIP</span>
        </label>
        <label class="jd-exporter-check">
          <input id="jd-exporter-excel-embed-images" type="checkbox" checked>
          <span>Excel 嵌入图片</span>
        </label>
        <div class="jd-exporter-grid">
          <div class="jd-exporter-field">
            <label for="jd-exporter-image-delay">图片间隔 ms</label>
            <input id="jd-exporter-image-delay" class="jd-exporter-input" type="number" min="0" step="100" value="1000">
          </div>
          <div class="jd-exporter-field">
            <label for="jd-exporter-image-batch-size">每批图片数</label>
            <input id="jd-exporter-image-batch-size" class="jd-exporter-input" type="number" min="1" value="30">
          </div>
        </div>
        <div class="jd-exporter-grid">
          <div class="jd-exporter-field">
            <label for="jd-exporter-image-batch-pause">批次休息秒</label>
            <input id="jd-exporter-image-batch-pause" class="jd-exporter-input" type="number" min="0" value="5">
          </div>
          <div class="jd-exporter-field">
            <label for="jd-exporter-image-max-failures">连续失败暂停</label>
            <input id="jd-exporter-image-max-failures" class="jd-exporter-input" type="number" min="1" value="2">
          </div>
        </div>
        <label class="jd-exporter-check">
          <input id="jd-exporter-image-cache-enabled" type="checkbox" checked>
          <span>启用图片缓存</span>
        </label>
        <div class="jd-exporter-grid">
          <div class="jd-exporter-field">
            <label for="jd-exporter-image-cache-days">缓存保留天数</label>
            <input id="jd-exporter-image-cache-days" class="jd-exporter-input" type="number" min="0" value="1">
          </div>
          <div class="jd-exporter-field">
            <label>缓存管理</label>
            <button class="jd-exporter-button jd-exporter-button-secondary" type="button" data-action="clear-cache">清空图片缓存</button>
          </div>
        </div>
        <div class="jd-exporter-actions">
          <button class="jd-exporter-button jd-exporter-button-primary" type="button" data-action="start">开始导出</button>
          <button class="jd-exporter-button jd-exporter-button-secondary" type="button" data-action="stop" disabled>停止</button>
        </div>
        <div class="jd-exporter-progress" aria-hidden="true"><div class="jd-exporter-bar"></div></div>
        <pre class="jd-exporter-log">准备就绪。建议先选较小年份试跑。</pre>
        <p class="jd-exporter-note">提示：如果京东要求重新登录或出现验证码，请手动处理后再继续。</p>
      </div>
    </section>
  `;
  document.documentElement.appendChild(root);

  const panel = root.querySelector(".jd-exporter-panel");
  const fab = root.querySelector(".jd-exporter-fab");
  const closeButton = root.querySelector(".jd-exporter-close");
  const startButton = root.querySelector('[data-action="start"]');
  const stopButton = root.querySelector('[data-action="stop"]');
  const clearCacheButton = root.querySelector('[data-action="clear-cache"]');
  const bar = root.querySelector(".jd-exporter-bar");
  const logBox = root.querySelector(".jd-exporter-log");
  const rangeSelect = root.querySelector("#jd-exporter-range");
  const startYearInput = root.querySelector("#jd-exporter-start-year");
  const endYearInput = root.querySelector("#jd-exporter-end-year");
  const statusSelect = root.querySelector("#jd-exporter-status");
  let isSyncingDateRange = false;

  fab.addEventListener("click", () => panel.classList.toggle("jd-exporter-hidden"));
  closeButton.addEventListener("click", () => panel.classList.add("jd-exporter-hidden"));
  rangeSelect.addEventListener("change", syncYearsFromRange);
  startYearInput.addEventListener("input", syncRangeFromYears);
  endYearInput.addEventListener("input", syncRangeFromYears);
  startButton.addEventListener("click", () => runExport().catch((error) => {
    const message = error?.message || String(error);
    if (abortRequested || message === "EXPORT_CANCELLED") {
      log("已停止。");
      return;
    }
    log(`失败：${message}`);
  }));
  stopButton.addEventListener("click", () => {
    abortRequested = true;
    log("收到停止请求，当前请求结束后会停下。");
    if (currentJobId) {
      sendMessage({
        type: "JD_EXPORT_CANCEL",
        jobId: currentJobId
      }).catch(() => {});
    }
  });
  clearCacheButton.addEventListener("click", () => clearImageCache().catch((error) => {
    log(`清空图片缓存失败：${error.message || error}`);
  }));
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "JD_EXPORT_PROGRESS" && message.message) {
        log(message.message);
      }
      return false;
    });
  }

  function setRunning(value) {
    isRunning = value;
    startButton.disabled = value;
    stopButton.disabled = !value;
  }

  function log(message) {
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `\n[${time}] ${message}`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setProgress(done, total) {
    const percent = total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
    bar.style.width = `${percent}%`;
  }

  function syncYearsFromRange() {
    if (isSyncingDateRange) return;
    isSyncingDateRange = true;

    if (rangeSelect.value === "all") {
      startYearInput.value = String(MIN_START_YEAR);
      endYearInput.value = String(CURRENT_YEAR);
    } else if (rangeSelect.value === "thisYear") {
      startYearInput.value = String(CURRENT_YEAR);
      endYearInput.value = String(CURRENT_YEAR);
    } else {
      startYearInput.value = String(DEFAULT_START_YEAR);
      endYearInput.value = String(CURRENT_YEAR);
    }

    isSyncingDateRange = false;
  }

  function syncRangeFromYears() {
    if (isSyncingDateRange) return;
    const startYear = numberOf("#jd-exporter-start-year", DEFAULT_START_YEAR);
    const endYear = numberOf("#jd-exporter-end-year", CURRENT_YEAR);

    isSyncingDateRange = true;
    if (startYear === CURRENT_YEAR && endYear === CURRENT_YEAR) {
      rangeSelect.value = "thisYear";
    } else if (startYear === MIN_START_YEAR && endYear === CURRENT_YEAR) {
      rangeSelect.value = "all";
    } else {
      rangeSelect.value = "years";
    }
    isSyncingDateRange = false;
  }

  function readConfig() {
    const startYear = Math.max(MIN_START_YEAR, numberOf("#jd-exporter-start-year", DEFAULT_START_YEAR));
    const endYear = numberOf("#jd-exporter-end-year", CURRENT_YEAR);
    const delayMs = Math.max(0, numberOf("#jd-exporter-delay", 1000));
    const maxPagesRaw = valueOf("#jd-exporter-max-pages").trim();
    const maxPagesPerSegment = maxPagesRaw ? Math.max(1, Number(maxPagesRaw)) : Infinity;
    const imageDelayMs = Math.max(0, numberOf("#jd-exporter-image-delay", 1000));
    const imageBatchSize = Math.max(1, numberOf("#jd-exporter-image-batch-size", 30));
    const imageBatchPauseMs = Math.max(0, numberOf("#jd-exporter-image-batch-pause", 5) * 1000);
    const imageMaxConsecutiveFailures = Math.max(1, numberOf("#jd-exporter-image-max-failures", 2));
    const imageCacheTtlDays = Math.max(0, numberOf("#jd-exporter-image-cache-days", 1));

    if (startYear > endYear) throw new Error("开始年份不能晚于结束年份");

    return {
      rangeMode: rangeSelect.value,
      startYear,
      endYear,
      statusFilter: statusSelect.value,
      delayMs,
      maxPagesPerSegment,
      exportFormat: valueOf("#jd-exporter-format"),
      splitYears: root.querySelector("#jd-exporter-split-years").checked,
      saveImages: root.querySelector("#jd-exporter-save-images").checked,
      excelEmbedImages: root.querySelector("#jd-exporter-excel-embed-images").checked,
      imageOptions: {
        delayMs: imageDelayMs,
        batchSize: imageBatchSize,
        batchPauseMs: imageBatchPauseMs,
        maxConsecutiveFailures: imageMaxConsecutiveFailures,
        cacheEnabled: root.querySelector("#jd-exporter-image-cache-enabled").checked,
        cacheTtlDays: imageCacheTtlDays
      }
    };
  }

  async function clearImageCache() {
    clearCacheButton.disabled = true;
    log("正在清空图片缓存...");
    try {
      const response = await sendMessage({ type: "JD_EXPORT_CLEAR_IMAGE_CACHE" });
      if (!response?.ok) throw new Error(response?.error || "清空图片缓存失败");
      log(`图片缓存已清空：${response.deleted || 0} 条`);
    } finally {
      clearCacheButton.disabled = false;
    }
  }

  function valueOf(selector) {
    return root.querySelector(selector).value;
  }

  function numberOf(selector, fallback) {
    const value = Number(valueOf(selector));
    return Number.isFinite(value) ? value : fallback;
  }

  function buildSegments(config) {
    if (config.rangeMode === "thisYear") return [{ label: String(CURRENT_YEAR), d: "2" }];
    const segments = [];
    const high = Math.min(config.endYear, CURRENT_YEAR);
    const low = Math.max(config.startYear, MIN_START_YEAR);

    if (config.rangeMode === "all" || high === CURRENT_YEAR) {
      segments.push({ label: String(CURRENT_YEAR), d: "2" });
    }

    for (let year = Math.min(high, CURRENT_YEAR - 1); year >= low; year -= 1) {
      segments.push({ label: String(year), d: String(year) });
    }

    return dedupeSegments(segments);
  }

  function dedupeSegments(segments) {
    const seen = new Set();
    return segments.filter((segment) => {
      const key = segment.d;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function runExport() {
    if (isRunning) return;
    abortRequested = false;
    currentJobId = makeJobId();
    setRunning(true);
    logBox.textContent = "开始导出...";
    setProgress(0, 1);

    try {
      const config = readConfig();
      config.jobId = currentJobId;
      const segments = buildSegments(config);
      if (!segments.length) throw new Error("没有可导出的日期段");

      const allRows = [];
      const rowsBySegment = [];
      let completedSegments = 0;

      for (const segment of segments) {
        if (abortRequested) throw new Error("EXPORT_CANCELLED");
        log(`处理 ${segment.label}`);
        const rows = await exportSegment(segment, config);
        allRows.push(...rows);
        rowsBySegment.push({ segment, rows });
        completedSegments += 1;
        setProgress(completedSegments, segments.length);
        log(`${segment.label} 完成：${rows.length} 条`);
        await sleep(config.delayMs);
      }

      const deduped = dedupeOrders(allRows);
      const summary = `完成：原始 ${allRows.length} 条，去重后 ${deduped.length} 条。`;
      log(summary);

      if (deduped.length) {
        if (config.splitYears) {
          await downloadSegmentResults(rowsBySegment, config);
        } else {
          await downloadResults(deduped, config);
        }
      } else {
        log("没有解析到订单，请确认页面已登录且选择范围内有订单。");
      }
    } finally {
      currentJobId = "";
      setRunning(false);
    }
  }

  function makeJobId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function exportSegment(segment, config) {
    const rows = [];
    let page = 1;
    let pagesRead = 0;
    const visited = new Set();
    const serialState = createSerialState();

    while (!abortRequested && pagesRead < config.maxPagesPerSegment && !visited.has(page)) {
      visited.add(page);
      pagesRead += 1;

      const url = makeOrderUrl(segment.d, page);
      const html = await fetchOrderPage(url);
      const doc = new DOMParser().parseFromString(html, "text/html");

      if (isLoginPage(doc, html)) {
        throw new Error("京东返回了登录页，请先在当前浏览器完成登录");
      }

      const pageRows = parseOrders(doc, segment, page, serialState);
      rows.push(...pageRows);
      log(`${segment.label} 第 ${page} 页：${pageRows.length} 条`);

      const nextPage = findNextPage(doc, page);
      if (!nextPage) break;
      page = nextPage;
      await sleep(config.delayMs);
    }

    return applyStatusFilter(rows, config.statusFilter);
  }

  function makeOrderUrl(d, page) {
    const url = new URL("/center/list.action", location.origin);
    url.searchParams.set("d", d);
    url.searchParams.set("s", "4096");
    url.searchParams.set("page", String(page));
    return url.toString();
  }

  async function fetchOrderPage(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`请求失败 ${response.status}: ${url}`);
    return response.text();
  }

  function isLoginPage(doc, html) {
    const title = doc.title || "";
    return title.includes("登录") || html.includes("passport.jd.com") || html.includes("扫码登录");
  }

  function parseOrders(doc, segment, page, serialState) {
    const blocks = [...doc.querySelectorAll(".order-tb tbody, table tbody")];
    const rows = [];

    for (const block of blocks) {
      const rawText = normalizeText(block.innerText || block.textContent || "");
      if (!rawText.includes("订单号：")) continue;
      const sequence = nextOrderSequence(rawText, serialState);
      rows.push(parseOrderBlock(block, rawText, segment, page, sequence));
    }

    return rows;
  }

  function parseOrderBlock(block, rawText, segment, page, sequence) {
    const orderNumber = rawText.match(/订单号：\s*(\d{8,})/)?.[1] || "";
    const orderTime = rawText.match(/(?:19|20)\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/)?.[0] || "";
    const amounts = [...rawText.matchAll(/¥\s*([0-9]+(?:\.[0-9]{1,2})?)/g)].map((match) => match[1]);
    const amount = amounts[0] || "";
    const splitParent = isSplitParent(rawText);
    const paymentMethod = matchFirst(rawText, ["在线支付", "货到付款", "公司转账", "白条支付", "京东支付", "微信支付", "支付宝", "银行卡支付"]);
    const status = matchFirst(rawText, ["已完成", "已取消", "已拆分", "等待付款", "待付款", "等待收货", "配送中", "已出库", "已收货", "已退款", "已拒收", "待评价"]);
    const products = parseProductItems(block);
    const productImageUrls = unique(products.map((product) => product.imageUrl).filter(Boolean));
    const quantityFromRaw = [...rawText.matchAll(/x\s*(\d+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0) || "";
    const quantityTotal = products.length
      ? products.reduce((sum, product) => sum + (Number(product.quantity) || 0), 0) || quantityFromRaw
      : quantityFromRaw;
    const productSummary = products.map((product) => {
      const quantity = product.quantity ? ` x${product.quantity}` : "";
      return `${product.name}${quantity}`;
    }).join(" | ");
    const detailLink = findOrderLink(block, orderNumber);
    const receiver = extractReceiver(block, rawText);

    const row = {
      rangeLabel: segment.label,
      page,
      sequence,
      orderTime,
      orderNumber,
      productSummary,
      productCount: products.length,
      productsJson: JSON.stringify(products),
      productImageUrls: productImageUrls.join(" | "),
      productImageFiles: "",
      quantityTotal,
      receiver,
      amount,
      paymentMethod,
      status,
      detailUrl: detailLink,
      rawText
    };

    return splitParent ? stripSplitParentProductFields(row, { status: "已拆分" }) : row;
  }

  function applyStatusFilter(rows, statusFilter) {
    if (statusFilter === "all") return rows;

    const targetStatus = statusFilter === "completed" ? "已完成" : "已取消";
    const filtered = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const children = collectSplitChildren(rows, index);

      if (children.length) {
        const keptChildren = children.filter((child) => child.status === targetStatus);
        if (keptChildren.length) {
          filtered.push(makeFilteredSplitParent(row, keptChildren, targetStatus), ...keptChildren);
        }
        index += children.length;
        continue;
      }

      if (row.status === targetStatus) {
        filtered.push(row);
      }
    }

    return filtered;
  }

  function collectSplitChildren(rows, parentIndex) {
    const parent = rows[parentIndex];
    const parentSequence = String(parent.sequence || "");
    if (!parentSequence || parentSequence.includes(".")) return [];

    const children = [];
    for (let index = parentIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      const sequence = String(row.sequence || "");
      if (!sequence.startsWith(`${parentSequence}.`)) break;
      children.push(row);
    }

    return children;
  }

  function makeFilteredSplitParent(parent, keptChildren, targetStatus) {
    const amount = sumAmounts(keptChildren) || parent.amount;
    const quantityTotal = sumNumericField(keptChildren, "quantityTotal") || parent.quantityTotal;
    return stripSplitParentProductFields({
      ...parent,
      amount,
      quantityTotal,
      status: targetStatus
    }, {
      status: "已拆分"
    });
  }

  function stripSplitParentProductFields(row, overrides = {}) {
    return {
      ...row,
      productSummary: "",
      productCount: "",
      productsJson: "[]",
      productImageUrls: "",
      productImageFiles: "",
      ...overrides
    };
  }

  function sumNumericField(rows, field) {
    const sum = rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
    return sum || "";
  }

  function sumAmounts(rows) {
    const cents = rows
      .map((row) => amountToCents(row.amount))
      .filter((value) => Number.isFinite(value));
    if (!cents.length) return "";
    return (cents.reduce((sum, value) => sum + value, 0) / 100).toFixed(2);
  }

  function amountToCents(amount) {
    const match = String(amount || "").match(/([0-9]+)(?:\.([0-9]{1,2}))?/);
    if (!match) return NaN;
    const yuan = Number(match[1]);
    const fraction = Number((match[2] || "").padEnd(2, "0"));
    return yuan * 100 + fraction;
  }

  function matchFirst(text, candidates) {
    return candidates.find((candidate) => text.includes(candidate)) || "";
  }

  function createSerialState() {
    return {
      next: 1,
      splitBase: "",
      splitIndex: 0,
      splitOrderTime: ""
    };
  }

  function nextOrderSequence(rawText, state) {
    const orderTime = rawText.match(/(?:19|20)\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/)?.[0] || "";
    const splitParent = isSplitParent(rawText);
    const splitChild = state.splitBase && orderTime && orderTime === state.splitOrderTime && !splitParent;

    if (splitChild) {
      state.splitIndex += 1;
      return `${state.splitBase}.${state.splitIndex}`;
    }

    if (state.splitBase && (!orderTime || orderTime !== state.splitOrderTime)) {
      state.splitBase = "";
      state.splitIndex = 0;
      state.splitOrderTime = "";
    }

    const sequence = String(state.next);
    state.next += 1;

    if (splitParent) {
      state.splitBase = sequence;
      state.splitIndex = 0;
      state.splitOrderTime = orderTime;
    }

    return sequence;
  }

  function isSplitParent(rawText) {
    return rawText.includes("已拆分")
      && rawText.includes("查看拆分详情")
      && rawText.includes("您订单中的商品");
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\u3000/g, " ")
      .replace(/[\t\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseProductItems(block) {
    const items = [];
    for (const link of block.querySelectorAll("a")) {
      const image = link.querySelector("img");
      const rawName = link.getAttribute("title")
        || normalizeText(link.textContent)
        || image?.getAttribute("alt")
        || image?.getAttribute("title")
        || "";
      const name = cleanProductName(rawName);
      if (!isProductName(name)) continue;

      const href = link.getAttribute("href") || "";
      const absoluteUrl = href && !href.startsWith("javascript:") && href !== "#none"
        ? new URL(href, location.origin).href
        : "";
      const productContainer = closestProductContainer(link);
      const containerText = normalizeText(productContainer?.innerText || productContainer?.textContent || "");
      const quantity = extractQuantity(containerText);
      const containerImage = productContainer?.querySelector("img");
      const imageUrl = getImageUrl(image) || getImageUrl(containerImage);
      const hasProductSignal = imageUrl
        || quantity
        || absoluteUrl.includes("item.jd.com")
        || absoluteUrl.includes("item.jd.hk");
      if (!hasProductSignal) continue;

      items.push({
        name,
        quantity,
        url: absoluteUrl,
        imageUrl
      });
    }

    return mergeProductItems(items);
  }

  function cleanProductName(value) {
    return normalizeText(value)
      .replace(/\s*x\s*\d+\s*$/i, "")
      .replace(/\s*申请售后\s*$/g, "")
      .trim();
  }

  function isProductName(text) {
    if (!text || text.length < 2) return false;
    if (ACTION_TEXTS.has(text)) return false;
    if (/^\d{8,}$/.test(text)) return false;
    if (/^x\s*\d+$/i.test(text)) return false;
    if (/^¥?\s*\d+(?:\.\d{1,2})?$/.test(text)) return false;
    if (text.includes("订单号")) return false;
    if (text.includes("订单详情")) return false;
    if (text.includes("查看拆分详情")) return false;
    return true;
  }

  function closestProductContainer(link) {
    const selectors = [
      ".goods-item",
      ".goods-msg",
      ".p-msg",
      ".item-msg",
      ".goods",
      "li",
      "td",
      "tr"
    ];
    for (const selector of selectors) {
      const node = link.closest(selector);
      if (node) return node;
    }
    return link.parentElement;
  }

  function extractQuantity(text) {
    const match = normalizeText(text).match(/(?:^|\s)x\s*(\d+)(?:\s|$)/i);
    return match ? Number(match[1]) : "";
  }

  function mergeProductItems(items) {
    const map = new Map();
    for (const item of items) {
      const hrefLooksNonProduct = NON_PRODUCT_HREF_PATTERNS.some((pattern) => item.url.includes(pattern));
      if (hrefLooksNonProduct && !item.imageUrl) continue;

      const key = `${item.name}\n${item.url}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, item);
        continue;
      }

      if (!existing.quantity && item.quantity) existing.quantity = item.quantity;
      if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    }

    return [...map.values()];
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function getImageUrl(image) {
    if (!image) return "";
    const candidates = [
      image.getAttribute("data-lazy-img"),
      image.getAttribute("data-original"),
      image.getAttribute("original"),
      image.getAttribute("src")
    ];

    for (const candidate of candidates) {
      const url = normalizeUrl(candidate);
      if (isUsableImageUrl(url)) return url;
    }

    return "";
  }

  function normalizeUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value || value.startsWith("data:")) return "";
    if (value.startsWith("//")) return `${location.protocol}${value}`;
    try {
      return new URL(value, location.origin).href;
    } catch (_error) {
      return "";
    }
  }

  function isUsableImageUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if (path.includes("blank.gif") || path.includes("loading.gif")) return false;
      return host.includes("360buyimg.com")
        || host.includes("jdimg.com")
        || /\.(jpg|jpeg|png|gif|webp|bmp|avif)(?:$|[!._-])/i.test(path);
    } catch (_error) {
      return false;
    }
  }

  function findOrderLink(block, orderNumber) {
    if (!orderNumber) return "";
    const link = [...block.querySelectorAll("a[href]")].find((item) => item.href.includes(`orderid=${orderNumber}`) || item.href.includes(`orderId=${orderNumber}`));
    return link ? link.href : "";
  }

  function extractReceiver(block, rawText) {
    const cells = [...block.querySelectorAll("td")].map((cell) => normalizeText(cell.innerText || cell.textContent || ""));
    const possible = cells.find((cell) => cell && cell.length <= 80 && !cell.includes("¥") && !cell.includes("订单详情") && !cell.includes("订单号：") && !cell.includes("x1"));
    return possible || "";
  }

  function findNextPage(doc, currentPage) {
    const nextLink = [...doc.querySelectorAll("a[href]")].find((link) => normalizeText(link.textContent) === "下一页");
    if (!nextLink) return null;
    const url = new URL(nextLink.getAttribute("href"), location.origin);
    const page = Number(url.searchParams.get("page"));
    return Number.isInteger(page) && page > currentPage ? page : null;
  }

  function dedupeOrders(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = row.orderNumber || `${row.rangeLabel}-${row.page}-${row.sequence}-${row.rawText}`;
      if (!map.has(key)) map.set(key, row);
    }
    return [...map.values()];
  }

  async function downloadResults(rows, config) {
    const stamp = makeDownloadTimestamp();
    const baseName = `jd-orders-${makeRangeLabel(config)}-${stamp}`;
    const needsImageMetadata = config.saveImages || (config.exportFormat === "xlsx" && config.excelEmbedImages);
    const outputRows = needsImageMetadata ? attachImageFilenames(rows) : rows;
    await downloadTable(baseName, outputRows, config);
    if (config.saveImages) await downloadImagesZipForRows(`${baseName}-images.zip`, outputRows, config);
  }

  async function downloadSegmentResults(rowsBySegment, config) {
    const stamp = makeDownloadTimestamp();
    for (const { segment, rows } of rowsBySegment) {
      const deduped = dedupeOrders(rows);
      if (!deduped.length) continue;
      const safeLabel = segment.label.replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, "");
      const baseName = `jd-orders-${safeLabel}-${stamp}`;
      const needsImageMetadata = config.saveImages || (config.exportFormat === "xlsx" && config.excelEmbedImages);
      const outputRows = needsImageMetadata ? attachImageFilenames(deduped) : deduped;
      await downloadTable(baseName, outputRows, config);
      if (config.saveImages) await downloadImagesZipForRows(`${baseName}-images.zip`, outputRows, config);
    }
  }

  async function downloadTable(baseName, rows, config) {
    const columns = getExportColumns();
    if (config.exportFormat === "xlsx") {
      await downloadExcel(`${baseName}.xlsx`, rows, columns, config);
      return;
    }

    await downloadFile(`${baseName}.csv`, toCsv(rows, columns), "text/csv;charset=utf-8");
  }

  function getExportColumns() {
    return [
      ["rangeLabel", "rangeLabel"],
      ["page", "page"],
      ["sequence", "sequence"],
      ["orderTime", "orderTime"],
      ["orderNumber", "orderNumber"],
      ["productSummary", "productSummary"],
      ["productCount", "productCount"],
      ["quantityTotal", "quantityTotal"],
      ["amount", "amount"],
      ["paymentMethod", "paymentMethod"],
      ["status", "status"],
      ["receiver", "receiver"],
      ["detailUrl", "detailUrl"],
      ["productImageUrls", "productImageUrls"]
    ];
  }

  function toCsv(rows, columns) {
    const lines = [columns.map(([, label]) => label).join(",")];
    for (const row of rows) {
      lines.push(columns.map(([key]) => csvEscape(row[key])).join(","));
    }
    return `\uFEFF${lines.join("\n")}`;
  }

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function makeDownloadTimestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${date}-${time}`;
  }

  function makeRangeLabel(config) {
    const startYear = Math.max(MIN_START_YEAR, Number(config.startYear) || MIN_START_YEAR);
    const endYear = Math.min(CURRENT_YEAR, Number(config.endYear) || CURRENT_YEAR);
    if (config.rangeMode === "thisYear") return String(CURRENT_YEAR);
    if (startYear === endYear) return String(startYear);
    return `${startYear}-${endYear}`;
  }

  function attachImageFilenames(rows) {
    const usedFilenames = new Set();

    return rows.map((row) => {
      const originalProducts = parseProductsJson(row.productsJson);
      const imageCount = originalProducts.filter((product) => product.imageUrl).length;
      let imageIndex = 0;
      const products = originalProducts.map((product) => {
        if (!product.imageUrl) return product;
        imageIndex += 1;
        const imageFile = reserveImageFilename(row, product, imageIndex, imageCount, usedFilenames);
        const cacheKey = makeImageCacheKey(row, imageIndex);
        return { ...product, imageFile, cacheKey };
      });
      const productImageFiles = unique(products.map((product) => product.imageFile).filter(Boolean)).join(" | ");

      return {
        ...row,
        productsJson: JSON.stringify(products),
        productImageFiles
      };
    });
  }

  function parseProductsJson(value) {
    try {
      const products = JSON.parse(value || "[]");
      return Array.isArray(products) ? products : [];
    } catch (_error) {
      return [];
    }
  }

  function reserveImageFilename(row, product, imageIndex, imageCount, usedFilenames) {
    const extension = getImageExtension(product.imageUrl);
    const orderStem = makeOrderImageStem(row);
    const stem = imageCount > 1
      ? `${orderStem}_${String(imageIndex).padStart(2, "0")}`
      : orderStem;
    let filename = `${stem}${extension}`;
    let suffix = 2;

    while (usedFilenames.has(filename)) {
      filename = `${stem}-${suffix}${extension}`;
      suffix += 1;
    }

    usedFilenames.add(filename);
    return filename;
  }

  function makeOrderImageStem(row) {
    const timePart = formatOrderTimeForFilename(row.orderTime);
    const orderPart = sanitizeFilename(row.orderNumber || `${row.rangeLabel}-${row.page}-${row.sequence}`) || "order";
    return sanitizeFilename(`${timePart}_${orderPart}`) || "order";
  }

  function makeImageCacheKey(row, imageIndex) {
    const orderPart = sanitizeFilename(row.orderNumber || `${row.rangeLabel}-${row.page}-${row.sequence}`);
    return orderPart ? `${orderPart}:${imageIndex}` : "";
  }

  function formatOrderTimeForFilename(orderTime) {
    const match = String(orderTime || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!match) return "unknown_time";
    return `${match[1]}${match[2]}${match[3]}_${match[4]}${match[5]}${match[6]}`;
  }

  function sanitizeFilename(value) {
    return normalizeText(value)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function getImageExtension(imageUrl) {
    try {
      const pathname = new URL(imageUrl).pathname;
      const match = pathname.match(/\.(jpg|jpeg|png|gif|webp|bmp|avif)(?:$|[!._-])/i);
      return match ? `.${match[1].toLowerCase()}` : ".jpg";
    } catch (_error) {
      return ".jpg";
    }
  }

  async function downloadImagesZipForRows(zipFilename, rows, config) {
    const entries = [];
    const seenEntryNames = new Set();
    for (const row of rows) {
      for (const product of parseProductsJson(row.productsJson)) {
        if (product.imageUrl && product.imageFile && !seenEntryNames.has(product.imageFile)) {
          seenEntryNames.add(product.imageFile);
          entries.push({
            name: product.imageFile,
            url: product.imageUrl,
            cacheKey: product.cacheKey
          });
        }
      }
    }

    if (!entries.length) {
      log("没有找到可下载的商品图片。");
      return;
    }

    log(`开始打包商品图片：${entries.length} 张`);
    const response = await sendMessage({
      type: "JD_EXPORT_DOWNLOAD_IMAGES_ZIP",
      filename: zipFilename,
      jobId: config.jobId,
      entries,
      options: config.imageOptions
    });
    if (!response?.ok) throw new Error(response?.error || "图片压缩包下载失败");
    log(`图片压缩包完成：${response.count || 0} 张成功，${response.cached || 0} 张来自缓存，${response.empty || 0} 张为空，${response.failed || 0} 张失败`);
  }

  async function downloadExcel(filename, rows, columns, config) {
    const excelColumns = config.excelEmbedImages ? withExcelPreviewColumn(columns) : columns;
    const imagePreviews = config.excelEmbedImages
      ? rows.map((row, index) => {
        const product = parseProductsJson(row.productsJson).find((item) => item.imageUrl);
      return product?.imageUrl ? { rowIndex: index, url: product.imageUrl, cacheKey: product.cacheKey } : null;
      }).filter(Boolean)
      : [];
    const response = await sendMessage({
      type: "JD_EXPORT_DOWNLOAD_XLSX",
      filename,
      jobId: config.jobId,
      columns: excelColumns,
      rows: rows.map((row) => pickFields(row, excelColumns)),
      imagePreviews,
      options: config.imageOptions
    });
    if (!response?.ok) throw new Error(response?.error || "Excel 下载失败");
    log(`Excel 完成：${response.imageCount || 0} 张图片已嵌入，${response.cachedImageCount || 0} 张来自缓存，${response.emptyImageCount || 0} 张为空`);
  }

  function withExcelPreviewColumn(columns) {
    const output = [];
    for (const column of columns) {
      if (column[0] === "productSummary") {
        output.push(["productImagePreview", "productImagePreview"]);
      }
      output.push(column);
    }
    return output;
  }

  function pickFields(row, columns) {
    const picked = {};
    for (const [key] of columns) {
      picked[key] = row[key] == null ? "" : row[key];
    }
    return picked;
  }

  async function downloadFile(filename, content, mimeType) {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        const response = await sendMessage({
          type: "JD_EXPORT_DOWNLOAD",
          filename,
          content,
          mimeType
        });
        if (response?.ok) return;
        throw new Error(response?.error || `下载失败：${filename}`);
      } catch (error) {
        log(`扩展下载通道不可用，改用页面下载：${error.message || error}`);
      }
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
