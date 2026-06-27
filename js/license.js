// ========== 审稿通 - 授权管理模块 ==========
// 使用 HMAC-SHA256 进行激活码本地校验
// 需要在 app.js 之前加载

var LICENSE_SECRET = 'sgt_review_secret_key_2026';
var LICENSE_KEY = 'app_license_data';
var TRIAL_KEY = 'app_trial_start';

var SUBSCRIPTION_PLANS = {
  trial:     { name: '试用',     days: 3 },
  weekly:    { name: '一周',     days: 7 },
  halfmonth: { name: '半月',     days: 15 },
  monthly:   { name: '月度',     days: 30 },
  quarterly: { name: '季度',     days: 90 },
  halfyear:  { name: '半年',     days: 180 },
  yearly:    { name: '年度',     days: 365 }
};

// ---------- HMAC-SHA256 工具 ----------

function hexToBytes(hex) {
  var bytes = [];
  for (var i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

function bytesToHex(bytes) {
  var hex = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i].toString(16);
    if (b.length === 1) hex.push('0');
    hex.push(b);
  }
  return hex.join('');
}

// 纯 JS HMAC-SHA256 实现（不依赖 Web Crypto API，兼容 file:// 协议）
function hmacSha256(message, secret) {
  var keyBytes = [];
  for (var i = 0; i < secret.length; i++) keyBytes.push(secret.charCodeAt(i));

  var blockSize = 64;
  if (keyBytes.length > blockSize) {
    keyBytes = sha256Hash(keyBytes);
  }
  while (keyBytes.length < blockSize) keyBytes.push(0);

  var oKeyPad = keyBytes.slice();
  var iKeyPad = keyBytes.slice();
  for (var i = 0; i < blockSize; i++) {
    oKeyPad[i] ^= 0x5c;
    iKeyPad[i] ^= 0x36;
  }

  var msgBytes = [];
  for (var i = 0; i < message.length; i++) msgBytes.push(message.charCodeAt(i));

  var innerHash = sha256Hash(iKeyPad.concat(msgBytes));
  var hmacBytes = sha256Hash(oKeyPad.concat(innerHash));

  return bytesToHex(hmacBytes);
}

// SHA-256 实现（正确版，兼容 file:// 协议）
function sha256Hash(bytes) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  var s256Constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  // 预处理：填充
  var originalLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length * 8) % 512 !== 448) bytes.push(0);

  // 添加长度（64位大端序）
  // 注意：JS 的 >>> 对 >=32 的移位操作只取低5位，所以不能直接 >>> 56
  // 这里分开处理高32位和低32位
  var lenLow = originalLength >>> 0;
  // 高32位：消息长度 < 2^32 bits (512MB) 时始终为 0
  bytes.push(0, 0, 0, 0);
  bytes.push((lenLow >>> 24) & 0xff);
  bytes.push((lenLow >>> 16) & 0xff);
  bytes.push((lenLow >>> 8) & 0xff);
  bytes.push(lenLow & 0xff);

  // 初始化哈希值
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // 处理每个 512-bit 块
  var w = [];
  for (var i = 0; i < bytes.length; i += 64) {
    // 将 16 个大端序 32-bit 字读入 w[0..15]
    for (var j = 0; j < 16; j++) {
      w[j] = ((bytes[i + j * 4] << 24) >>> 0) +
             ((bytes[i + j * 4 + 1] << 16) >>> 0) +
             ((bytes[i + j * 4 + 2] << 8) >>> 0) +
             bytes[i + j * 4 + 3];
      w[j] = w[j] >>> 0;
    }

    // 扩展到 64 个字
    for (var j = 16; j < 64; j++) {
      var s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      var s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = ((w[j - 16] + s0 + w[j - 7] + s1) >>> 0) >>> 0;
    }

    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (var j = 0; j < 64; j++) {
      var S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      var ch = (e & f) ^ ((~e) & g);
      ch = ch >>> 0;
      var temp1 = ((h + S1 + ch + s256Constants[j] + w[j]) >>> 0) >>> 0;
      var S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      maj = maj >>> 0;
      var temp2 = ((S0 + maj) >>> 0) >>> 0;

      h = g; g = f; f = e;
      e = ((d + temp1) >>> 0) >>> 0;
      d = c; c = b; b = a;
      a = ((temp1 + temp2) >>> 0) >>> 0;
    }

    h0 = ((h0 + a) >>> 0) >>> 0;
    h1 = ((h1 + b) >>> 0) >>> 0;
    h2 = ((h2 + c) >>> 0) >>> 0;
    h3 = ((h3 + d) >>> 0) >>> 0;
    h4 = ((h4 + e) >>> 0) >>> 0;
    h5 = ((h5 + f) >>> 0) >>> 0;
    h6 = ((h6 + g) >>> 0) >>> 0;
    h7 = ((h7 + h) >>> 0) >>> 0;
  }

  // 输出大端序字节
  var result = [];
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function(hVal) {
    result.push((hVal >>> 24) & 0xff);
    result.push((hVal >>> 16) & 0xff);
    result.push((hVal >>> 8) & 0xff);
    result.push(hVal & 0xff);
  });
  return result;
}

// 生成 HMAC 签名
function signPayload(payload, secret) {
  return hmacSha256(payload, secret);
}

// ---------- 授权数据管理 ----------

function loadLicenseData() {
  try {
    var data = localStorage.getItem(LICENSE_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

function saveLicenseData(data) {
  localStorage.setItem(LICENSE_KEY, JSON.stringify(data));
}

function clearLicenseData() {
  localStorage.removeItem(LICENSE_KEY);
}

// ---------- 验证激活码 ----------

function validateLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, message: '请输入激活码' };
  }

  var parts = key.trim().split('.');
  if (parts.length !== 2) {
    return { valid: false, message: '激活码格式无效' };
  }

  var payload = parts[0];
  var sig = parts[1];

  // 计算期望签名
  var expectedSig = signPayload(payload, LICENSE_SECRET);

  // 比对签名（不区分大小写）
  if (sig.toLowerCase() !== expectedSig.toLowerCase()) {
    return { valid: false, message: '激活码无效，请检查后重新输入' };
  }

  // 解析 payload
  var payloadStr;
  try {
    // 尝试标准 base64 解码
    try {
      payloadStr = atob(payload);
    } catch (e) {
      // 尝试 base64url 解码
      var b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      payloadStr = atob(b64);
    }
  } catch (e) {
    return { valid: false, message: '激活码数据损坏' };
  }

  var data;
  try {
    data = JSON.parse(payloadStr);
  } catch (e) {
    return { valid: false, message: '激活码数据格式错误' };
  }

  if (!data.plan || !data.exp || !data.uid) {
    return { valid: false, message: '激活码数据不完整' };
  }

  if (!SUBSCRIPTION_PLANS[data.plan]) {
    return { valid: false, message: '无效的套餐类型' };
  }

  // 检查有效期
  var expiryDate = new Date(data.exp + 'T23:59:59');
  var now = new Date();
  if (expiryDate < now) {
    return { valid: false, message: '激活码已过期（' + data.exp + '）' };
  }

  return {
    valid: true,
    plan: data.plan,
    planName: SUBSCRIPTION_PLANS[data.plan].name,
    expiry: data.exp,
    uid: data.uid,
    message: '激活成功'
  };
}

// 激活（保存授权）
function activateLicense(key) {
  var result = validateLicenseKey(key);
  if (!result.valid) return result;

  saveLicenseData({
    plan: result.plan,
    planName: result.planName,
    expiry: result.expiry,
    uid: result.uid,
    activatedAt: new Date().toISOString()
  });

  // 清除试用标记（如果有）
  localStorage.removeItem(TRIAL_KEY);

  // 非阻塞上报激活信息到后台
  reportActivationToServer(result);

  return result;
}

// ---------- 授权状态查询 ----------

// 将到期日期格式化为 YYYY-MM-DD HH:mm 显示
function formatExpiryDisplay(dateObj) {
  if (!dateObj) return null;
  var d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (isNaN(d.getTime())) return null;
  var y = d.getFullYear();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  var hh = ('0' + d.getHours()).slice(-2);
  var mm = ('0' + d.getMinutes()).slice(-2);
  return y + '-' + m + '-' + day + ' ' + hh + ':' + mm;
}

// 获取授权状态
function getLicenseStatus() {
  var data = loadLicenseData();
  if (!data) {
    // 检查是否有试用
    var trialStart = localStorage.getItem(TRIAL_KEY);
    if (trialStart) {
      var start = new Date(trialStart);
      var now = new Date();
      var daysUsed = Math.floor((now - start) / (1000 * 60 * 60 * 24));
      var daysLeft = Math.max(0, 3 - daysUsed);
      var trialEnd = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
      return {
        activated: false,
        onTrial: true,
        plan: 'trial',
        planName: '试用',
        daysLeft: daysLeft,
        daysUsed: daysUsed,
        isExpired: daysLeft <= 0,
        expiry: trialEnd.toISOString().slice(0, 10),
        expiryTime: formatExpiryDisplay(trialEnd)
      };
    }
    return {
      activated: false,
      onTrial: false,
      plan: null,
      planName: null,
      daysLeft: 0,
      isExpired: true,
      expiry: null,
      expiryTime: null
    };
  }

  // 已激活（激活码）
  var expiryDate = new Date(data.expiry + 'T23:59:59');
  var now = new Date();
  var msLeft = expiryDate - now;
  var daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  var isExpired = msLeft <= 0;

  return {
    activated: true,
    onTrial: false,
    plan: data.plan,
    planName: data.planName || (SUBSCRIPTION_PLANS[data.plan] ? SUBSCRIPTION_PLANS[data.plan].name : '未知'),
    daysLeft: daysLeft,
    isExpired: isExpired,
    expiry: data.expiry,
    expiryTime: formatExpiryDisplay(expiryDate),
    uid: data.uid
  };
}

// 启动试用
function startTrial() {
  var now = new Date();
  localStorage.setItem(TRIAL_KEY, now.toISOString());
  return getLicenseStatus();
}

// 检查是否可以访问
function checkAccess() {
  var status = getLicenseStatus();
  return !status.isExpired;
}

// ---------- 后台激活上报 ----------

// 后台服务器地址（首次启动服务器后设置，如 http://localhost:3000）
var ADMIN_SERVER_URL = localStorage.getItem('admin_server_url') || '';

function setAdminServerUrl(url) {
  ADMIN_SERVER_URL = url;
  localStorage.setItem('admin_server_url', url);
}

// 激活成功后向后台上报（非阻塞，失败不影响本地使用）
function reportActivationToServer(activationResult) {
  if (!ADMIN_SERVER_URL) return; // 未配置后台地址，不上报

  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', ADMIN_SERVER_URL + '/api/report', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        // 上报完成（忽略结果，不影响用户体验）
        console.log('[审稿通] 激活上报 ' + (xhr.status === 200 ? '成功' : '失败'));
      }
    };
    xhr.send(JSON.stringify({
      uid: activationResult.uid,
      plan: activationResult.plan,
      expiry: activationResult.expiry,
      activatedAt: new Date().toISOString()
    }));
  } catch (e) {
    // 静默失败
  }
}

// ---------- 导出（供 app.js 使用） ----------