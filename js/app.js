// 稿件类型映射（select value -> 中文名称）
const DOC_TYPE_MAP = {
  'auto': null,
  'proposal': '方案',
  'work-report': '工作汇报',
  'speech-draft': '讲话稿',
  'application': '申报材料',
  'notice': '通知',
  'copywriting': '文案策划',
  'news': '新闻稿',
  'speech': '研讨发言',
  'host-words': '主持词',
  'summary': '总结报告',
  'summary-speech': '总结讲话'
};

// ========== 全局变量 ==========
var currentRawMarkdown = '';
var _isReviewing = false, _splitTotal = 0, _compareMode = false, _originalContentForCompare = '', _lastFileName = ''; // 并发请求锁
var HISTORY_KEY = 'review_history';
var HISTORY_MAX = 500;
var HISTORY_MAX_SIZE = 4 * 1024 * 1024; // 4MB localStorage 安全阈值

// ========== 语料库管理 ==========
const CORPUS_KEY = 'corpus_data';
const CORPUS_MAX = 100;

// 规则卡分类
var RULE_CATEGORIES = {
  'leader-order': '领导职务排序规则',
  'company-name': '公司名称及简称',
  'dept-name': '内部部门名称',
  'sensitive-words': '敏感词/违禁表述清单',
  'format-spec': '特定格式规范'
};

// 语料库分类
var CORPUS_CATEGORIES = {
  'mainstream-exp': '近期主流表达',
  'superior-ref': '上级单位相关资料',
  'internal-ref': '公司内部资料'
};

// 当前语料库 tab
var _currentCorpusTab = 'rule';

// API 提供商配置（含 contextWindow 用于动态阈值）
var API_PROVIDERS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', contextWindow: 64000 },
  qwen:     { name: '千问 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', contextWindow: 32000 },
  doubao:   { name: '豆包 (Doubao)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', contextWindow: 128000 },
  kimi:     { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', contextWindow: 128000 },
  glm:      { name: 'GLM (智谱)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', contextWindow: 128000 },
  minimax:  { name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01', contextWindow: 256000 },
  stepfun:  { name: '阶跃星辰 (StepFun)', baseUrl: 'https://api.stepfun.com/v1', model: 'step-1-128k', contextWindow: 128000 },
  hunyuan:  { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-pro', contextWindow: 256000 },
  custom:   { name: '自定义', baseUrl: '', model: '', contextWindow: 32000 }
};

// 加载语料数据
function loadCorpus() {
  try {
    const data = localStorage.getItem(CORPUS_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('读取语料库失败:', e);
  }
  return [];
}

// 保存语料数据
function saveCorpus(data) {
  try {
    localStorage.setItem(CORPUS_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('保存语料库失败:', e);
    showToast('语料库保存失败，请减少条目或内容', 'error');
  }
}

// 格式化语料为提示词片段（供 api.js 调用）
function getCorpusPrompt() {
  const data = loadCorpus();
  if (!data.length) return { rule: '', corpus: '' };

  const rules = data.filter(function(i) { return (i.type || 'corpus') === 'rule' && i.content.trim(); });
  const corpora = data.filter(function(i) { return (i.type || 'corpus') === 'corpus' && i.content.trim(); });

  var rulePrompt = '';
  if (rules.length) {
    rulePrompt = '\n\n## ⚠️ 规则卡（必须遵守的硬性规定）\n\n';
    rules.forEach(function(item) {
      rulePrompt += '### ' + (item.label || '未命名规则') + '\n' + item.content + '\n\n';
    });
    rulePrompt += '**以上规则卡内容为必须遵守的硬性规定，审核时必须逐条对照检查，发现违反必须指出。**\n';
  }

  var corpusPrompt = '';
  if (corpora.length) {
    corpusPrompt = '\n\n## 📖 参考语料库（风格参考）\n\n';
    corpora.forEach(function(item) {
      corpusPrompt += '### ' + (item.label || '未命名语料') + '\n' + item.content + '\n\n';
    });
    corpusPrompt += '**语料库内容为参考建议，在符合规则卡的前提下优先参考。规则卡与语料库冲突时以规则卡为准。**\n';
  }

  return { rule: rulePrompt, corpus: corpusPrompt };
}

// 打开语料库弹窗
function openCorpusModal() {
  const overlay = document.getElementById('corpusOverlay');
  overlay.classList.add('modal-overlay--active');
  // 重置为规则卡 tab
  _currentCorpusTab = 'rule';
  document.querySelectorAll('.corpus-tab').forEach(function(t) {
    t.classList.toggle('corpus-tab--active', t.dataset.type === 'rule');
  });
  renderCorpusItems();
}

// 关闭语料库弹窗
function closeCorpusModal() {
  document.getElementById('corpusOverlay').classList.remove('modal-overlay--active');
}

// 渲染语料条目列表
function renderCorpusItems() {
  const container = document.getElementById('corpusList');
  const hintEl = document.getElementById('corpusHint');
  var data = window._corpusTempData || loadCorpus();

  // 更新 hint
  if (hintEl) {
    hintEl.textContent = _currentCorpusTab === 'rule'
      ? '设置领导排序、敏感词等硬性规则，审核时必须遵守'
      : '设置近期主流表达、参考资料等风格参考，审核时建议对齐';
  }

  // 按当前 tab 过滤
  var tabType = _currentCorpusTab;
  var categories = tabType === 'rule' ? RULE_CATEGORIES : CORPUS_CATEGORIES;
  var filtered = data.filter(function(item) {
    return (item.type || 'corpus') === tabType;
  });

  if (!filtered || filtered.length === 0) {
    container.innerHTML = '<div class="corpus-empty">暂无' + (tabType === 'rule' ? '规则卡' : '语料库') + '条目，点击上方「添加条目」开始创建</div>';
    return;
  }

  // 按分类分组
  var grouped = {};
  filtered.forEach(function(item) {
    var cat = item.category || '';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });

  // 渲染分组
  var html = '';
  Object.keys(categories).forEach(function(catKey) {
    var items = grouped[catKey];
    if (!items || items.length === 0) return;
    html += '<div class="corpus-group">' +
      '<div class="corpus-group__title">' + categories[catKey] + ' (' + items.length + ')' + '</div>';
    items.forEach(function(item) {
      var selectedCat = item.category || '';
      var selectedOptions = Object.keys(categories).map(function(k) {
        return '<option value="' + k + '"' + (selectedCat === k ? ' selected' : '') + '>' + categories[k] + '</option>';
      }).join('');
      html += '<div class="corpus-item" data-id="' + item.id + '">' +
        '<div class="corpus-item__header">' +
        '<input class="corpus-item__label-input" type="text" value="' + escapeHtml(item.label) + '"' +
        ' placeholder="条目名称" data-id="' + item.id + '" data-field="label">' +
        '<select class="corpus-item__category-select" data-id="' + item.id + '" data-field="category">' +
        selectedOptions +
        '</select>' +
        '<button class="corpus-item__upload-btn" title="上传文件" data-id="' + item.id + '">📂</button>' +
        '<button class="corpus-item__del" title="删除条目" data-id="' + item.id + '">&times;</button>' +
        '</div>' +
        '<textarea class="corpus-item__content-textarea" placeholder="' + (tabType === 'rule' ? '粘贴规则卡内容…' : '粘贴参考语料内容…') + '"' +
        ' data-id="' + item.id + '" data-field="content">' + escapeHtml(item.content) + '</textarea>' +
        '</div>';
    });
    html += '</div>';
  });

  container.innerHTML = html || '<div class="corpus-empty">暂无' + (tabType === 'rule' ? '规则卡' : '语料库') + '条目</div>';

  // 绑定删除事件
  container.querySelectorAll('.corpus-item__del').forEach(function(btn) {
    btn.addEventListener('click', function() {
      deleteCorpusItem(this.dataset.id);
    });
  });

  // 绑定上传事件
  container.querySelectorAll('.corpus-item__upload-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      uploadCorpusFile(this.dataset.id);
    });
  });

  // 分类下拉变化自动保存
  container.querySelectorAll('.corpus-item__category-select').forEach(function(el) {
    el.addEventListener('change', function() {
      var id = this.dataset.id;
      var field = this.dataset.field;
      var d = window._corpusTempData || loadCorpus();
      var item = d.find(function(x) { return x.id === id; });
      if (item) {
        item[field] = this.value;
        window._corpusTempData = d;
      }
    });
  });

  // 输入变化自动保存到临时数据
  container.querySelectorAll('input[data-field], textarea[data-field]').forEach(function(el) {
    el.addEventListener('input', function() {
      var id = this.dataset.id;
      var field = this.dataset.field;
      var d = window._corpusTempData || loadCorpus();
      var item = d.find(function(x) { return x.id === id; });
      if (item) {
        item[field] = this.value;
        window._corpusTempData = d;
      }
    });
  });
}

// 添加新条目
function addCorpusItem(type, label, content) {
  var t = type || _currentCorpusTab;
  var defaultCat = t === 'rule' ? 'leader-order' : 'mainstream-exp';
  const data = window._corpusTempData || loadCorpus();
  if (data.length >= CORPUS_MAX) {
    showToast('最多支持 ' + CORPUS_MAX + ' 条条目', 'error');
    return;
  }
  const newItem = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    type: t,
    label: label || (t === 'rule' ? '新规则' : '新语料'),
    category: defaultCat,
    content: content || ''
  };
  data.push(newItem);
  window._corpusTempData = data;
  renderCorpusItems();
}

// 删除条目
function deleteCorpusItem(id) {
  let data = window._corpusTempData || loadCorpus();
  data = data.filter(d => d.id !== id);
  window._corpusTempData = data;
  renderCorpusItems();
}

// 上传文件（支持 .txt/.md/.docx/.wps/.xlsx/.xls/.et）
function uploadCorpusFile(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.docx,.wps,.xlsx,.xls,.et';
  input.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    var fileName = file.name;
    var ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    handleCorpusFileUpload(id, file, ext);
  });
  input.click();
}

function handleCorpusFileUpload(id, file, ext) {
  if (ext === '.txt' || ext === '.md') {
    var reader = new FileReader();
    reader.onload = function(ev) {
      setCorpusContent(id, ev.target.result, file.name);
    };
    reader.readAsText(file, 'UTF-8');
  } else if (ext === '.docx' || ext === '.wps') {
    if (typeof mammoth === 'undefined') {
      showToast('文档解析库未加载，请检查网络', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function(ev) {
      mammoth.extractRawText({ arrayBuffer: ev.target.result })
        .then(function(result) {
          setCorpusContent(id, result.value || '(空文档)', file.name);
        })
        .catch(function(err) {
          showToast('解析文档失败: ' + (err.message || '格式不支持'), 'error');
        });
    };
    reader.readAsArrayBuffer(file);
  } else if (ext === '.xlsx' || ext === '.xls' || ext === '.et') {
    if (typeof XLSX === 'undefined') {
      showToast('表格解析库未加载，请检查网络', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var workbook = XLSX.read(ev.target.result, { type: 'array' });
        var text = '';
        workbook.SheetNames.forEach(function(name) {
          var sheet = workbook.Sheets[name];
          var csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) {
            text += (text ? '\n' : '') + '--- 工作表: ' + name + ' ---\n' + csv;
          }
        });
        setCorpusContent(id, text || '(空表格)', file.name);
      } catch (err) {
        showToast('解析表格失败: ' + (err.message || '格式不支持'), 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    showToast('不支持的格式: ' + ext, 'error');
  }
}

function setCorpusContent(id, content, fileName) {
  var data = window._corpusTempData || loadCorpus();
  var item = data.find(function(d) { return d.id === id; });
  if (item) {
    item.content = '<!-- 来自文件: ' + fileName + ' -->\n' + content;
    window._corpusTempData = data;
    renderCorpusItems();
    showToast('已上传: ' + fileName, 'success');
  }
}

// 保存语料库（从弹窗保存）
function saveCorpusFromModal() {
  const data = window._corpusTempData;
  if (data) {
    saveCorpus(data);
    window._corpusTempData = null;
    closeCorpusModal();
    showToast('语料库保存成功，下次审核将自动对齐', 'success');
  } else {
    closeCorpusModal();
  }
}

// 清空全部语料
function clearAllCorpus() {
  var typeLabel = _currentCorpusTab === 'rule' ? '规则卡' : '语料库';
  if (!confirm('确定要清空全部' + typeLabel + '条目吗？此操作不可撤销。')) return;
  var data = window._corpusTempData || loadCorpus();
  data = data.filter(function(item) { return (item.type || 'corpus') !== _currentCorpusTab; });
  window._corpusTempData = data;
  renderCorpusItems();
  showToast(typeLabel + '已清空', 'info');
}

// ========== 设置弹窗 ==========
function openSettingsModal() {
  // 渲染配置选择器
  renderProfileSelector();
  // 填充当前活跃配置到表单
  fillProfileForm();
  document.getElementById('modalOverlay').classList.add('modal-overlay--active');
}

function closeSettingsModal() {
  document.getElementById('modalOverlay').classList.remove('modal-overlay--active');
}

// 渲染配置选择器下拉
function renderProfileSelector() {
  var sel = document.getElementById('profileSelector');
  if (!sel) return;
  var profiles = loadApiProfiles();
  var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  sel.innerHTML = '<option value="">-- 选择配置 --</option>';
  profiles.forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + (p.model || '未设置') + ')';
    if (p.id === activeId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// 填充当前选中配置到表单
function fillProfileForm(profileId) {
  var profiles = loadApiProfiles();
  var id = profileId || localStorage.getItem(ACTIVE_PROFILE_KEY);
  var profile = profiles.find(function(p) { return p.id === id; });
  if (!profile) {
    // 无 profile 时使用默认值
    document.getElementById('apiProvider').value = 'deepseek';
    document.getElementById('apiBaseUrl').value = 'https://api.deepseek.com';
    document.getElementById('apiKey').value = '';
    document.getElementById('modelName').value = 'deepseek-v4-flash';
    return;
  }
  document.getElementById('apiProvider').value = profile.provider || 'custom';
  document.getElementById('apiBaseUrl').value = profile.baseUrl || '';
  document.getElementById('apiKey').value = profile.apiKey || '';
  document.getElementById('modelName').value = profile.model || '';
}

// 保存设置
function saveSettings() {
  var provider = document.getElementById('apiProvider').value;
  var baseUrl = document.getElementById('apiBaseUrl').value.trim();
  var apiKey = document.getElementById('apiKey').value.trim();
  var model = document.getElementById('modelName').value.trim();
  if (!apiKey) {
    showToast('请输入 API Key', 'error');
    return;
  }

  var profiles = loadApiProfiles();
  var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  var existing = profiles.find(function(p) { return p.id === activeId; });

  var PROVIDER_NAMES = {
    deepseek: 'DeepSeek', qwen: '千问', doubao: '豆包',
    kimi: 'Kimi', glm: 'GLM', minimax: 'MiniMax',
    stepfun: '阶跃星辰', hunyuan: '腾讯混元', custom: '自定义'
  };
  var name = PROVIDER_NAMES[provider] || '未命名';
  var config = { provider: provider, baseUrl: baseUrl, apiKey: apiKey, model: model, name: name };

  if (existing) {
    // 更新已有配置
    existing.provider = provider;
    existing.baseUrl = baseUrl;
    existing.apiKey = apiKey;
    existing.model = model;
    saveApiProfiles(profiles);
    // 更新 API_CONFIG
    API_CONFIG.baseUrl = baseUrl;
    API_CONFIG.apiKey = apiKey;
    API_CONFIG.model = model;
  } else {
    // 无活跃配置则新建
    saveApiConfig(config);
  }

  // 更新 header 标签
  var label = document.getElementById('profileQuickLabel');
  if (label) label.textContent = '🤖 ' + (model || '未设置');

  // 重渲染选择器
  renderProfileSelector();
  closeSettingsModal();
  showToast('设置已保存', 'success');
}

// 渲染 header 快速切换菜单
function renderQuickMenu() {
  var menu = document.getElementById('profileQuickMenu');
  if (!menu) return;
  var profiles = loadApiProfiles();
  var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  if (!profiles.length) {
    menu.innerHTML = '<div class="profile-item" style="color:var(--text-muted);cursor:default;">暂无配置</div>';
    return;
  }
  var html = '';
  profiles.forEach(function(p) {
    var isActive = p.id === activeId;
    html += '<button class="profile-item' + (isActive ? ' profile-item--active' : '') + '" data-profile-id="' + p.id + '">' +
      '<span class="profile-item__name">' + (p.name || '未命名') + '</span>' +
      '<span class="profile-item__model">' + (p.model || '') + '</span>' +
      (isActive ? '<span class="profile-item__check">✓</span>' : '') +
      '</button>';
  });
  menu.innerHTML = html;

  // 绑定点击切换
  menu.querySelectorAll('.profile-item[data-profile-id]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var pid = this.dataset.profileId;
      setActiveProfile(pid);
      menu.classList.add('hidden');
    });
  });
}

// ========== 历史弹窗 ==========
function openHistoryModal() {
  document.getElementById('historyOverlay').classList.add('modal-overlay--active');
  renderHistory();
}

function closeHistoryModal() {
  document.getElementById('historyOverlay').classList.remove('modal-overlay--active');
}

// ========== 关于弹窗 ==========
function openAboutModal() {
  var overlay = document.getElementById('aboutOverlay');
  var content = document.getElementById('aboutContent');
  fetch('version.json')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      content.innerHTML =
        '<div style="margin-bottom:12px;padding:12px;background:var(--color-primary-light, #E8F3FF);border-radius:var(--radius-sm);">' +
        '<div style="font-size:0.85rem;color:var(--text-secondary);">当前版本</div>' +
        '<div style="font-size:1.4rem;font-weight:700;color:var(--primary);">v' + data.version + '</div>' +
        '</div>' +
        '<div class="about-row"><span style="color:var(--text-muted);">发布日期</span><span>' + (data.releaseDate || '未知') + '</span></div>' +
        '<div class="about-row" style="border-bottom:none;"><span style="color:var(--text-muted);">版权信息</span><span>' + (data.copyright || '') + ' ' + (data.phone || '') + '</span></div>' +
        '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);text-align:left;">' +
        '<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:6px;">📝 更新内容</div>' +
        '<div style="font-size:0.88rem;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;">' + (data.updateLog || '无') + '</div>' +
        '</div>';
      overlay.classList.add('modal-overlay--active');
    })
    .catch(function() {
      showToast('无法获取版本信息', 'error');
    });
}

// ========== 历史记录 ==========
function saveToHistory(docType, content, rawMarkdown) {
  var history = loadHistory();
  var preview = content.replace(/\s+/g, ' ').substring(0, 80);

  // 文件名称：优先取上传文件名，否则取内容前 2 行
  var fileName = _lastFileName || '';
  if (!fileName && content) {
    var lines = content.split('\n');
    var firstLines = [];
    for (var i = 0; i < lines.length && firstLines.length < 2; i++) {
      var trimmed = lines[i].trim();
      if (trimmed) firstLines.push(trimmed);
    }
    fileName = firstLines.join(' | ');
    if (fileName.length > 50) fileName = fileName.substring(0, 50);
  }

  var stats = parseReviewStats(rawMarkdown);
  history.unshift({
    id: Date.now().toString(),
    docType: docType,
    fileName: fileName,
    preview: preview,
    rawMarkdown: rawMarkdown,
    time: new Date().toLocaleString('zh-CN'),
    stats: stats
  });
  // 按数量裁剪
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  // 按大小裁剪（序列化后超过 4MB 则从末尾删除，直到低于阈值）
  var raw = JSON.stringify(history);
  while (raw.length > HISTORY_MAX_SIZE && history.length > 1) {
    history.pop();
    raw = JSON.stringify(history);
  }
  localStorage.setItem(HISTORY_KEY, raw);
  // 接近存储上限时提示用户
  if (history.length > HISTORY_MAX * 0.85) {
    showToast('历史记录已达 ' + history.length + ' 条，建议导出备份后清理', 'warning');
  } else if (raw.length > HISTORY_MAX_SIZE * 0.85) {
    showToast('历史数据体积较大，建议导出备份后清理', 'warning');
  }
}

function loadHistory() {
  try {
    var data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
}

function renderHistory() {
  var list = document.getElementById('historyList');
  var history = loadHistory();

  // 获取筛选条件
  var searchKeyword = document.getElementById('historySearch') ? document.getElementById('historySearch').value.trim().toLowerCase() : '';
  var typeFilter = document.getElementById('historyTypeFilter') ? document.getElementById('historyTypeFilter').value : '';
  var dateFilter = document.getElementById('historyDateFilter') ? document.getElementById('historyDateFilter').value : '';

  // 筛选
  if (searchKeyword || typeFilter || dateFilter) {
    history = history.filter(function(item) {
      if (searchKeyword && item.preview.toLowerCase().indexOf(searchKeyword) === -1) return false;
      if (typeFilter && item.docType !== typeFilter) return false;
      if (dateFilter && item.time.indexOf(dateFilter) === -1) return false;
      return true;
    });
  }

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="history-empty">暂无审核记录' +
      (searchKeyword || typeFilter || dateFilter ? '（请调整筛选条件）' : '') +
      '</div>';
    return;
  }

  list.innerHTML = history.map(function(item) {
    return '<div class="history-item" data-id="' + item.id + '">' +
      '<div class="history-item__info">' +
      '<div class="history-item__top">' +
      '<span class="history-item__date">' + escapeHtml(item.time) + '</span>' +
      '<span class="history-item__type">' + escapeHtml(item.docType) + '</span>' +
      '</div>' +
      '<div class="history-item__preview">' + escapeHtml(item.preview) + '</div>' +
      '</div>' +
      '<button class="history-item__del" data-id="' + item.id + '">&times;</button>' +
      '</div>';
  }).join('');

  // 事件委托：监听整个列表的点击
  list._delegateListener && list.removeEventListener('click', list._delegateListener);
  list._delegateListener = function(e) {
    var item = e.target.closest('.history-item');
    if (!item) return;
    var id = item.dataset.id;
    if (e.target.classList.contains('history-item__del')) {
      e.stopPropagation();
      deleteHistoryItem(id);
    } else {
      viewHistoryItem(id);
    }
  };
  list.addEventListener('click', list._delegateListener);
}

function viewHistoryItem(id) {
  var history = loadHistory();
  var item = history.find(function(h) { return h.id === id; });
  if (!item) return;
  currentRawMarkdown = item.rawMarkdown;
  // 从历史查看时也保存到 sessionStorage（支持刷新恢复）
  sessionStorage.setItem('last_review_result', item.rawMarkdown);
  document.getElementById('resultEmpty').classList.add('hidden');
  document.getElementById('resultError').classList.add('hidden');
  document.getElementById('resultContent').classList.remove('hidden');
  document.getElementById('resultLoading').classList.add('hidden');
  document.getElementById('markdownOutput').innerHTML = marked.parse(item.rawMarkdown, { breaks: true, gfm: true, async: false });
  closeHistoryModal();
  showToast('已加载历史记录', 'info');
}

function deleteHistoryItem(id) {
  var history = loadHistory().filter(function(h) { return h.id !== id; });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function clearAllHistory() {
  if (!confirm('确定要清空全部审核历史吗？')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  showToast('审核历史已清空', 'info');
}

// ========== 质量趋势看板 ==========
// 解析审核结果中的结构化数据
function parseReviewStats(markdown) {
  if (!markdown || typeof markdown !== 'string') return null;
  var result = {
    totalErrors: 0,
    errorBreakdown: [],
    highSeverityCount: 0,
    score: null,
    wordCount: null
  };

  // 解析问题总览表格：### 二、问题总览 下的 | 类别 | 数量 | 严重程度 |
  var tableSection = markdown.match(/###\s*二、问题总览[\s\S]*?(?=###|$)/);
  if (tableSection) {
    var lines = tableSection[0].split('\n');
    for (var i = 0; i < lines.length; i++) {
      var row = lines[i].match(/^\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/);
      if (row) {
        var category = row[1].trim();
        var count = parseInt(row[2], 10);
        var severity = row[3].trim();
        result.errorBreakdown.push({ category: category, count: count, severity: severity });
        result.totalErrors += count;
        if (severity === '高') result.highSeverityCount += count;
      }
    }
  }

  // 计算评分：拼写错误/错别字和前后不一致每项扣3分，其他每项扣2分，高严重度额外扣3分
  var scoreDeduction = 0;
  for (var si = 0; si < result.errorBreakdown.length; si++) {
    var item = result.errorBreakdown[si];
    var isImportant = /拼写|错别字|错字/.test(item.category) || /不一致|前后/.test(item.category);
    var perItemDeduction = isImportant ? 3 : 2;
    scoreDeduction += item.count * perItemDeduction;
    if (item.severity === '高') scoreDeduction += item.count * 3;
  }
  result.score = Math.max(0, 100 - scoreDeduction);

  // 解析字数变化
  var wcMatch = markdown.match(/字数变化[：:]\s*原文(\d+)字\s*[→➡]\s*润色后(\d+)字/);
  if (wcMatch) {
    result.wordCount = { original: parseInt(wcMatch[1], 10), revised: parseInt(wcMatch[2], 10) };
  }

  return result;
}

// 看板状态
var _dashChartInstances = {};

// 计算看板统计数据
function computeDashboardStats(history, startDate, endDate) {
  if (!history || !history.length) return null;

  // 按时间筛选
  var filtered = history;
  if (startDate || endDate) {
    filtered = history.filter(function(item) {
      var t = new Date(item.time);
      if (startDate && t < new Date(startDate)) return false;
      if (endDate) {
        var end = new Date(endDate);
        end.setHours(23, 59, 59);
        if (t > end) return false;
      }
      return true;
    });
  }

  // 筛选有 stats 数据的条目
  var valid = filtered.filter(function(item) { return item.stats && item.stats.score !== null; });
  if (!valid.length) return { totalDocs: 0, totalErrors: 0, avgScore: 0, passRate: 0, byDocType: {}, byErrorCategory: {}, trend: [], passRateTrend: [] };

  var stats = {
    totalDocs: valid.length,
    totalErrors: 0,
    avgScore: 0,
    passRate: 0,
    passCount: 0,
    byDocType: {},
    byErrorCategory: {},
    trend: {},
    passRateTrend: {}
  };

  var scoreSum = 0;

  valid.forEach(function(item) {
    var s = item.stats;
    stats.totalErrors += s.totalErrors;
    scoreSum += s.score;
    if (s.score >= 80) stats.passCount++;

    // 按稿件类型
    var dt = item.docType || '其他';
    if (!stats.byDocType[dt]) stats.byDocType[dt] = { count: 0, totalErrors: 0, scoreSum: 0, passCount: 0 };
    stats.byDocType[dt].count++;
    stats.byDocType[dt].totalErrors += s.totalErrors;
    stats.byDocType[dt].scoreSum += s.score;
    if (s.score >= 80) stats.byDocType[dt].passCount++;

    // 按错误类型
    if (s.errorBreakdown) {
      s.errorBreakdown.forEach(function(e) {
        if (!stats.byErrorCategory[e.category]) stats.byErrorCategory[e.category] = { count: 0, severity: e.severity };
        stats.byErrorCategory[e.category].count += e.count;
      });
    }

    // 按时间（按周聚合: YYYY-WW）
    var d = new Date(item.time);
    var year = d.getFullYear();
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var period = year + '-' + month;
    if (!stats.trend[period]) stats.trend[period] = { docs: 0, scoreSum: 0, passCount: 0 };
    stats.trend[period].docs++;
    stats.trend[period].scoreSum += s.score;
    if (s.score >= 80) stats.trend[period].passCount++;
  });

  stats.avgScore = Math.round(scoreSum / valid.length);
  stats.passRate = Math.round((stats.passCount / valid.length) * 100);

  // 转换为数组
  var trendArr = [];
  var passRateArr = [];
  Object.keys(stats.trend).sort().forEach(function(p) {
    var t = stats.trend[p];
    trendArr.push({ period: p, docs: t.docs, avgScore: Math.round(t.scoreSum / t.docs), passRate: Math.round((t.passCount / t.docs) * 100) });
    passRateArr.push({ period: p, rate: Math.round((t.passCount / t.docs) * 100) });
  });
  stats.trend = trendArr;
  stats.passRateTrend = passRateArr;

  // byDocType 转数组
  var dtArr = [];
  Object.keys(stats.byDocType).forEach(function(k) {
    var v = stats.byDocType[k];
    dtArr.push({ docType: k, count: v.count, totalErrors: v.totalErrors, avgScore: Math.round(v.scoreSum / v.count), passRate: Math.round((v.passCount / v.count) * 100) });
  });
  stats.byDocType = dtArr;

  // byErrorCategory 转数组排序
  var ecArr = [];
  Object.keys(stats.byErrorCategory).forEach(function(k) {
    ecArr.push({ category: k, count: stats.byErrorCategory[k].count, severity: stats.byErrorCategory[k].severity });
  });
  ecArr.sort(function(a, b) { return b.count - a.count; });
  stats.byErrorCategory = ecArr;

  return stats;
}

// 打开看板弹窗
function openDashboardModal() {
  var overlay = document.getElementById('dashboardOverlay');
  overlay.classList.add('modal-overlay--active');
  // 重置筛选为「全部」
  document.querySelectorAll('.dash-filter-btn').forEach(function(b) {
    b.classList.toggle('dash-filter-btn--active', b.dataset.range === 'all');
  });
  document.getElementById('dashDateStart').value = '';
  document.getElementById('dashDateEnd').value = '';
  _renderDashboard();
}

// 关闭看板弹窗
function closeDashboardModal() {
  document.getElementById('dashboardOverlay').classList.remove('modal-overlay--active');
  // 销毁 Chart.js 实例释放内存
  Object.keys(_dashChartInstances).forEach(function(k) {
    if (_dashChartInstances[k]) { _dashChartInstances[k].destroy(); delete _dashChartInstances[k]; }
  });
}

// 渲染看板
function _renderDashboard() {
  var overlay = document.getElementById('dashboardOverlay');
  if (!overlay.classList.contains('modal-overlay--active')) return;

  // 销毁旧图表
  Object.keys(_dashChartInstances).forEach(function(k) {
    if (_dashChartInstances[k]) { _dashChartInstances[k].destroy(); delete _dashChartInstances[k]; }
  });

  var startDate = document.getElementById('dashDateStart').value;
  var endDate = document.getElementById('dashDateEnd').value;
  var history = loadHistory();
  var stats = computeDashboardStats(history, startDate, endDate);

  var emptyEl = document.getElementById('dashEmpty');
  var cardsEl = document.getElementById('dashCards');
  var chartsEl = document.querySelector('.dash-charts');

  if (!stats || !stats.totalDocs) {
    emptyEl.classList.remove('hidden');
    cardsEl.innerHTML = '';
    chartsEl.style.display = 'none';
    return;
  }

  emptyEl.classList.add('hidden');
  chartsEl.style.display = 'grid';

  // 渲染概览卡片
  cardsEl.innerHTML =
    '<div class="dash-card dash-card--primary"><div class="dash-card__value">' + stats.totalDocs + '</div><div class="dash-card__label">总审核稿件数</div></div>' +
    '<div class="dash-card dash-card--warning"><div class="dash-card__value">' + stats.totalErrors + '</div><div class="dash-card__label">发现总问题数</div></div>' +
    '<div class="dash-card ' + (stats.avgScore >= 80 ? 'dash-card--success' : 'dash-card--danger') + '"><div class="dash-card__value">' + stats.avgScore + '</div><div class="dash-card__label">平均分</div></div>' +
    '<div class="dash-card ' + (stats.passRate >= 80 ? 'dash-card--success' : stats.passRate >= 60 ? 'dash-card--warning' : 'dash-card--danger') + '"><div class="dash-card__value">' + stats.passRate + '%</div><div class="dash-card__label">合格率</div></div>';

  // 渲染合格率趋势（折线图）
  _renderChartLine('chartPassRate', '合格率 %', stats.passRateTrend, '#4A7B8C');

  // 渲染错误类型分布（柱状图）
  _renderChartBar('chartErrors', stats.byErrorCategory);

  // 渲染稿件类型表格
  _renderDocTypeTable(stats.byDocType);

  // 渲染审核记录明细表格
  _renderDetailTable(history, startDate, endDate);
}

// 渲染折线图
function _renderChartLine(canvasId, label, data, color) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || !data || !data.length) return;
  var ctx = canvas.getContext('2d');
  _dashChartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(function(d) { return d.period; }),
      datasets: [{
        label: label,
        data: data.map(function(d) { return d.rate; }),
        borderColor: color,
        backgroundColor: color.replace(')', ',0.15)').replace('rgb', 'rgba'),
        tension: 0.3,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: function(v) { return v + '%'; } } }
      }
    }
  });
}

// 渲染柱状图（错误类型分布）
function _renderChartBar(canvasId, data) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || !data || !data.length) return;
  var ctx = canvas.getContext('2d');
  var top = data.slice(0, 10);
  _dashChartInstances[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(function(d) { return d.category.length > 10 ? d.category.substring(0, 10) + '…' : d.category; }),
      datasets: [{
        label: '错误数量',
        data: top.map(function(d) { return d.count; }),
        backgroundColor: '#6B9AAA',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

// 渲染审核记录明细表格
function _renderDetailTable(history, startDate, endDate) {
  var tbody = document.getElementById('dashDetailBody');
  if (!tbody) return;

  // 按时间筛选
  var filtered = history;
  if (startDate || endDate) {
    filtered = history.filter(function(item) {
      var t = new Date(item.time);
      if (startDate && t < new Date(startDate)) return false;
      if (endDate) { var end = new Date(endDate); end.setHours(23, 59, 59); if (t > end) return false; }
      return true;
    });
  }

  // 取有 stats 的记录，按时间倒序
  var records = filtered.filter(function(item) { return item.stats && item.stats.score !== null; });
  records.sort(function(a, b) { return new Date(b.time) - new Date(a.time); });

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">暂无数据</td></tr>';
    return;
  }

  var html = '';
  records.forEach(function(item) {
    var passed = item.stats.score >= 80;
    var fname = item.fileName || '';
    if (fname.length > 35) fname = fname.substring(0, 35) + '…';
    html += '<tr>' +
      '<td title="' + (item.fileName || '') + '">' + fname + '</td>' +
      '<td>' + (item.time || '') + '</td>' +
      '<td>' + (item.docType || '其他') + '</td>' +
      '<td>' + item.stats.score + '</td>' +
      '<td>' + item.stats.totalErrors + '</td>' +
      '<td class="' + (passed ? 'pass-yes' : 'pass-no') + '">' + (passed ? '✔' : '✘') + '</td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
}

// 渲染稿件类型分析表格
function _renderDocTypeTable(data) {
  var container = document.getElementById('dashDocTypeTable');
  if (!container) return;
  if (!data || !data.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">暂无数据</div>';
    return;
  }
  var html = '<table class="dash-type-table"><thead><tr>' +
    '<th>稿件类型</th><th>篇数</th><th>总问题</th><th>平均分</th><th>合格率</th>' +
    '</tr></thead><tbody>';
  data.forEach(function(d) {
    html += '<tr>' +
      '<td>' + d.docType + '</td>' +
      '<td>' + d.count + '</td>' +
      '<td>' + d.totalErrors + '</td>' +
      '<td>' + d.avgScore + '</td>' +
      '<td>' + d.passRate + '%</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// 导出 Markdown 报告
function exportDashboardReport() {
  var startDate = document.getElementById('dashDateStart').value;
  var endDate = document.getElementById('dashDateEnd').value;
  var dateRangeStr = '全部时间';
  if (startDate && endDate) dateRangeStr = startDate + ' ~ ' + endDate;
  else if (startDate) dateRangeStr = startDate + ' 起';
  else if (endDate) dateRangeStr = endDate + ' 止';

  var history = loadHistory();
  var stats = computeDashboardStats(history, startDate, endDate);
  if (!stats || !stats.totalDocs) {
    showToast('暂无数据可导出', 'error');
    return;
  }

  var report = '';
  report += '# 质量趋势报告\n\n';
  report += '**时间范围**: ' + dateRangeStr + '  \n';
  report += '**生成时间**: ' + new Date().toLocaleString('zh-CN') + '  \n\n';

  report += '## 概览\n\n';
  report += '| 指标 | 数值 |\n';
  report += '|---|---|\n';
  report += '| 总审核稿件数 | ' + stats.totalDocs + ' |\n';
  report += '| 发现总问题数 | ' + stats.totalErrors + ' |\n';
  report += '| 平均分 | ' + stats.avgScore + ' |\n';
  report += '| 合格率 | ' + stats.passRate + '% |\n\n';

  report += '## 按稿件类型\n\n';
  report += '| 类型 | 篇数 | 总问题 | 平均分 | 合格率 |\n';
  report += '|---|---|---|---|---|\n';
  stats.byDocType.forEach(function(d) {
    report += '| ' + d.docType + ' | ' + d.count + ' | ' + d.totalErrors + ' | ' + d.avgScore + ' | ' + d.passRate + '% |\n';
  });
  report += '\n';

  report += '## 常见错误类型 Top 5\n\n';
  report += '| 问题类别 | 次数 | 严重度 |\n';
  report += '|---|---|---|\n';
  stats.byErrorCategory.slice(0, 5).forEach(function(e) {
    report += '| ' + e.category + ' | ' + e.count + ' | ' + e.severity + ' |\n';
  });
  report += '\n';

  report += '## 合格率趋势\n\n';
  report += '| 时间段 | 合格率 |\n';
  report += '|---|---|\n';
  stats.passRateTrend.forEach(function(t) {
    report += '| ' + t.period + ' | ' + t.rate + '% |\n';
  });
  report += '\n';

  // 审核记录明细
  report += '## 审核记录明细\n\n';
  report += '| 文件名称 | 时间 | 稿件类型 | 得分 | 问题数 | 合格 |\n';
  report += '|---|---|---|---|---|---|\n';
  var filteredHistory = history;
  if (startDate || endDate) {
    filteredHistory = history.filter(function(item) {
      var t = new Date(item.time);
      if (startDate && t < new Date(startDate)) return false;
      if (endDate) { var end = new Date(endDate); end.setHours(23, 59, 59); if (t > end) return false; }
      return true;
    });
  }
  filteredHistory.forEach(function(item) {
    if (item.stats && item.stats.score !== null) {
      var passed = item.stats.score >= 80 ? '✔' : '✘';
      var fname = item.fileName || '';
      if (fname.length > 40) fname = fname.substring(0, 40) + '…';
      report += '| ' + fname + ' | ' + (item.time || '') + ' | ' + (item.docType || '其他') + ' | ' + item.stats.score + ' | ' + item.stats.totalErrors + ' | ' + passed + ' |\n';
    }
  });

  // 下载 .md 文件
  var blob = new Blob(['\uFEFF' + report], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '质量趋势报告_' + new Date().toISOString().slice(0, 10) + '.md';
  a.click();
  URL.revokeObjectURL(url);

  // 同时复制到剪贴板
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(report).then(function() {
      showToast('Markdown 报告已下载并复制到剪贴板', 'success');
    }).catch(function() {
      showToast('Markdown 报告已下载', 'success');
    });
  } else {
    showToast('Markdown 报告已下载', 'success');
  }
}

// 导出 CSV 数据
function exportDashboardCsv() {
  var startDate = document.getElementById('dashDateStart').value;
  var endDate = document.getElementById('dashDateEnd').value;
  var history = loadHistory().filter(function(item) {
    var t = new Date(item.time);
    if (startDate && t < new Date(startDate)) return false;
    if (endDate) { var end = new Date(endDate); end.setHours(23, 59, 59); if (t > end) return false; }
    return true;
  });

  // CSV 头
  var csv = '\uFEFF文件名称,时间,稿件类型,得分,问题数,是否合格\n';
  history.forEach(function(item) {
    if (item.stats && item.stats.score !== null) {
      var passed = item.stats.score >= 80 ? '是' : '否';
      var fname = (item.fileName || '').replace(/"/g, '""');
      csv += '"' + fname + '","' +
        (item.time || '') + '","' +
        (item.docType || '其他') + '",' +
        item.stats.score + ',' +
        item.stats.totalErrors + ',' +
        passed + '\n';
    }
  });

  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '质量趋势数据_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV 已下载', 'success');
}

// ========== 数据导出/导入 ==========
function exportAllData() {
  var data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    history: loadHistory(),
    corpus: loadCorpus(),
    settings: {
      profiles: loadApiProfiles(),
      activeProfileId: localStorage.getItem(ACTIVE_PROFILE_KEY) || ''
    }
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '审稿通数据备份_' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('数据已导出', 'success');
}

function importAllData(file) {
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data = JSON.parse(ev.target.result);
      if (!data.version) { showToast('无效的备份文件', 'error'); return; }
      if (data.history && Array.isArray(data.history)) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(data.history));
      }
      if (data.corpus && Array.isArray(data.corpus)) {
        localStorage.setItem(CORPUS_KEY, JSON.stringify(data.corpus));
      }
      if (data.settings) {
        if (data.settings.profiles && Array.isArray(data.settings.profiles)) {
          saveApiProfiles(data.settings.profiles);
          if (data.settings.activeProfileId) {
            localStorage.setItem(ACTIVE_PROFILE_KEY, data.settings.activeProfileId);
            setActiveProfile(data.settings.activeProfileId);
          }
        }
      }
      renderHistory();
      showToast('数据导入成功，页面已更新', 'success');
    } catch (e) {
      showToast('导入失败：文件格式错误', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ========== 审核核心 ==========
async function startReview() {
  // 保存原文供对照模式使用
  _originalContentForCompare = document.getElementById('docContent').value;
  // 并发请求保护
  if (_isReviewing) {
    showToast('正在审核中，请稍候…', 'info');
    return;
  }
  _isReviewing = true;

  var content = document.getElementById('docContent').value.trim();
  if (!content) {
    _isReviewing = false;
    showToast('请先输入待审核的稿件内容', 'error');
    return;
  }

  // 动态计算字数阈值（基于所选模型的 contextWindow）
  var providerKey = document.getElementById('apiProvider').value;
  var provider = API_PROVIDERS[providerKey] || API_PROVIDERS.deepseek;
  var ctxWindow = provider.contextWindow || 32000;
  var warnThreshold = Math.floor(ctxWindow * 0.5);
  var blockThreshold = Math.floor(ctxWindow * 0.65);

  var contentLen = content.length;
  var shouldSplit = false;
  if (contentLen > blockThreshold) {
    // 超过阻止阈值：询问是否分段
    _isReviewing = false;
    document.getElementById('startBtn').disabled = false;
    if (!confirm('文档过长（' + contentLen + '字），超过当前模型（' + provider.name + '）的安全长度。\n\n是否自动分段审核（每段约8000字）？')) {
      showToast('已取消审核，建议分段后分别提交', 'info');
      return;
    }
    shouldSplit = true;
    _isReviewing = true;
    document.getElementById('startBtn').disabled = true;
  } else if (contentLen > warnThreshold) {
    showToast('文档较长（' + contentLen + '字），当前模型（' + provider.name + '）最大支持约' + ctxWindow + ' tokens，建议分段审核', 'warning');
  }

  var apiKey = API_CONFIG.apiKey;
  if (!apiKey) {
    _isReviewing = false;
    showToast('请先在设置中配置 API Key', 'error');
    openSettingsModal();
    return;
  }

  document.getElementById('resultEmpty').classList.add('hidden');
  document.getElementById('resultError').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('resultLoading').classList.remove('hidden');
  document.getElementById('startBtn').disabled = true;

  // 重置并激活加载步骤
  resetLoadingSteps();
  setStepActive(1);

  try {
    var docTypeSelect = document.getElementById('docType');
    var selectedType = docTypeSelect.value;

    var result;
    if (shouldSplit) {
      // 分段审核模式
      setStepActive(2);
      var docTypeName = selectedType === 'auto' ? null : (DOC_TYPE_MAP[selectedType] || '通用文稿');
      var splitResult = await splitAndReview(content, docTypeName);
      result = {
        documentType: docTypeName || '分段审核',
        typeConfidence: null,
        reviewResult: splitResult
      };
    } else if (selectedType === 'auto') {
      setStepActive(2);
      result = await fullReview(content);
    } else {
      setStepActive(2);
      var docTypeName = DOC_TYPE_MAP[selectedType] || '通用文稿';
      setStepActive(3);
      var reviewResult = await reviewDocument(content, docTypeName);
      result = {
        documentType: docTypeName,
        typeConfidence: null,
        reviewResult: reviewResult
      };
    }

    setStepActive(4);
    currentRawMarkdown = result.reviewResult;
    document.getElementById('markdownOutput').innerHTML = marked.parse(result.reviewResult, { breaks: true, gfm: true, async: false });
    document.getElementById('resultLoading').classList.add('hidden');
    document.getElementById('resultContent').classList.remove('hidden');

    // 保存审核结果到 sessionStorage（页面刷新恢复）
    sessionStorage.setItem('last_review_result', result.reviewResult);

    saveToHistory(result.documentType, content, result.reviewResult);

  } catch (err) {
    document.getElementById('resultLoading').classList.add('hidden');
    document.getElementById('resultError').classList.remove('hidden');
    document.getElementById('errorMessage').textContent = err.message || '请求失败，请检查网络连接后重试。';
  } finally {
    _isReviewing = false;
    document.getElementById('startBtn').disabled = false;
  }
}

// ========== 分段审核 ==========
var _splitTotal = 0;  // 分段总数（用于进度显示）

// 长文档分段审核：按段落拆分为 ≤8000 字的片段，逐段调用 API，合并结果
async function splitAndReview(content, docTypeName) {
  // 1. 按双换行拆分段落
  var paragraphs = content.split(/\n\s*\n/);
  // 2. 合并段落为片段，每段 ≤8000 字
  var segments = [];
  var current = '';
  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i];
    if ((current + '\n' + p).length > 8000) {
      if (current) segments.push(current);
      current = p;
    } else {
      current = current ? current + '\n' + p : p;
    }
  }
  if (current) segments.push(current);

  _splitTotal = segments.length;
  // 更新加载步骤：扩展步骤3显示分段进度
  var step3 = document.getElementById('step3');
  var step3OriginalText = step3 ? step3.textContent : '';

  // 3. 逐段审核
  var fullResult = '';
  for (var i = 0; i < segments.length; i++) {
    // 更新步骤3的文本为当前段进度
    if (step3) step3.textContent = '📝 审核第 ' + (i + 1) + '/' + segments.length + ' 段…';
    // 如果是自动识别类型，每段都做分类
    var segDocType = docTypeName;
    if (!segDocType) {
      setStepActive(2);
      var classifyResult = await classifyDocument(segments[i]);
      segDocType = classifyResult.type || '通用文稿';
    }
    setStepActive(3);
    var segmentResult = await reviewDocument(segments[i], segDocType || '通用文稿');
    fullResult += '--- 第' + (i + 1) + '/' + segments.length + '段 ---\n' + segmentResult + '\n\n';
  }

  // 恢复步骤3文本
  if (step3) step3.textContent = step3OriginalText || '📝 审稿中…';
  _splitTotal = 0;
  return fullResult;
}

// ========== 结果操作 ==========
function clearAll() {
  document.getElementById('docContent').value = '';
  document.getElementById('charCount').textContent = '0';
  document.getElementById('resultEmpty').classList.remove('hidden');
  document.getElementById('resultError').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('resultLoading').classList.add('hidden');
  currentRawMarkdown = '';
  sessionStorage.removeItem('last_review_result');
  _lastFileName = '';
  _compareMode = false;
  var toggleBtn = document.getElementById('compareToggleBtn');
  if (toggleBtn) toggleBtn.textContent = '📊 对照模式';
}

// ========== 原文/润色对照 ==========
function toggleCompare() {
  _compareMode = !_compareMode;
  var mdOut = document.getElementById('markdownOutput');
  var cmpPanel = document.getElementById('comparePanel');
  var btn = document.getElementById('compareToggleBtn');
  if (!mdOut || !cmpPanel || !btn) return;
  if (_compareMode) {
    mdOut.classList.add('hidden');
    cmpPanel.classList.remove('hidden');
    var origEl = document.getElementById('compareOriginal');
    if (origEl) origEl.textContent = _originalContentForCompare || '';
    var resEl = document.getElementById('compareResult');
    if (resEl && currentRawMarkdown) {
      resEl.innerHTML = marked.parse(currentRawMarkdown, { breaks: true, gfm: true, async: false });
    }
    btn.textContent = '📋 标准模式';
  } else {
    mdOut.classList.remove('hidden');
    cmpPanel.classList.add('hidden');
    btn.textContent = '📊 对照模式';
  }
}

function retryReview() {
  startReview();
}

function copyMarkdown() {
  if (!currentRawMarkdown) {
    showToast('暂无审核结果可复制', 'error');
    return;
  }
  navigator.clipboard.writeText(currentRawMarkdown).then(function() {
    showToast('已复制到剪贴板', 'success');
  }).catch(function() {
    showToast('复制失败，请手动选择复制', 'error');
  });
}

function downloadMarkdown() {
  if (!currentRawMarkdown) {
    showToast('暂无审核结果可下载', 'error');
    return;
  }
  var blob = new Blob([currentRawMarkdown], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  var dateStr = new Date().toISOString().slice(0, 10);
  var contentText = document.getElementById('docContent').value;
  var firstLine = '';
  if (contentText) {
    var lines = contentText.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed) {
        firstLine = trimmed;
        break;
      }
    }
    if (firstLine.length > 30) firstLine = firstLine.substring(0, 30);
  }
  var titlePart = firstLine ? '+' + firstLine : '';
  a.download = '审核报告_' + dateStr + titlePart + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('已下载 .md 文件', 'success');
}

// ========== 暗色模式 ==========
function toggleTheme() {
  var html = document.documentElement;
  var btn = document.getElementById('themeToggle');
  if (html.getAttribute('data-theme') === 'dark') {
    html.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
    if (btn) btn.textContent = '🌙';
  } else {
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
    if (btn) btn.textContent = '☀️';
  }
}

function loadTheme() {
  var saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = '☀️';
  }
}

function backToMain() {
  document.getElementById('resultEmpty').classList.remove('hidden');
  document.getElementById('resultError').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('resultLoading').classList.add('hidden');
  currentRawMarkdown = '';
  sessionStorage.removeItem('last_review_result');
  _lastFileName = '';
  _compareMode = false;
  var toggleBtn = document.getElementById('compareToggleBtn');
  if (toggleBtn) toggleBtn.textContent = '📊 对照模式';
  document.getElementById('inputPanel').scrollIntoView({ behavior: 'smooth' });
}

// 加载版本号
function loadVersion() {
  // 先显示缓存的版本号（如果有）
  var cached = localStorage.getItem('cached_version');
  if (cached) {
    var badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = cached;
  }

  // 异步从 version.json 获取最新版本号
  fetch('version.json')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.version) {
        var badge = document.getElementById('versionBadge');
        if (badge) badge.textContent = data.version;
        localStorage.setItem('cached_version', data.version);
        // 版本变化高亮检测
        detectVersionChange();
      }
    })
    .catch(function(err) {
      console.warn('加载版本号失败，使用缓存的版本号:', err);
    });
}

// 版本号变化高亮提示
function highlightVersion() {
  var badge = document.getElementById('versionBadge');
  if (!badge) return;
  badge.style.transition = 'none';
  badge.style.background = 'rgba(34, 197, 94, 0.4)';
  badge.style.borderColor = 'rgba(34, 197, 94, 0.7)';
  badge.style.color = '#22c55e';
  setTimeout(function() {
    badge.style.transition = 'all 0.8s ease';
    badge.style.background = 'rgba(251, 191, 36, 0.25)';
    badge.style.borderColor = 'rgba(251, 191, 36, 0.5)';
    badge.style.color = '#fbbf24';
  }, 1500);
}

// 检测版本号是否变化（与上次访问对比）
function detectVersionChange() {
  var prevVersion = localStorage.getItem('_prev_version');
  var currentVersion = document.getElementById('versionBadge').textContent;
  if (prevVersion && prevVersion !== currentVersion) {
    highlightVersion();
  }
  localStorage.setItem('_prev_version', currentVersion);
}

// 点击版本号显示「关于」弹窗
document.addEventListener('DOMContentLoaded', function() {
  var badge = document.getElementById('versionBadge');
  if (badge) badge.addEventListener('click', openAboutModal);

  // Changelog 关闭事件
  var changelogClose = document.getElementById('changelogClose');
  var changelogCloseBtn = document.getElementById('changelogCloseBtn');
  var changelogOverlay = document.getElementById('changelogOverlay');
  if (changelogClose) changelogClose.addEventListener('click', function() {
    changelogOverlay.classList.remove('modal-overlay--active');
  });
  if (changelogCloseBtn) changelogCloseBtn.addEventListener('click', function() {
    changelogOverlay.classList.remove('modal-overlay--active');
  });
  if (changelogOverlay) changelogOverlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('modal-overlay--active');
  });

  // ========== 关于弹窗 ==========
  var aboutOverlay = document.getElementById('aboutOverlay');
  var aboutClose = document.getElementById('aboutClose');
  var aboutCloseBtn = document.getElementById('aboutCloseBtn');
  if (aboutClose) aboutClose.addEventListener('click', function() {
    aboutOverlay.classList.remove('modal-overlay--active');
  });
  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', function() {
    aboutOverlay.classList.remove('modal-overlay--active');
  });
  if (aboutOverlay) aboutOverlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('modal-overlay--active');
  });
});

// 关闭页面时清除 API Key（如果开启了该选项）
// ========== 授权激活界面 ==========

function showActivationScreen() {
  var overlay = document.getElementById('activationOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  updateActivationStatus();

  // 从 version.json 加载联系方式
  var phoneEl = document.getElementById('activationContactPhone');
  if (phoneEl) {
    fetch('version.json').then(function(r) { return r.json(); }).then(function(v) {
      phoneEl.textContent = v.phone || '18919090798';
    }).catch(function() {
      phoneEl.textContent = '18919090798';
    });
  }
}

function updateActivationStatus() {
  var container = document.getElementById('activationStatus');
  if (!container) return;
  var status = getLicenseStatus();

  // 已激活但已到期（激活码到期）
  if (status.activated && status.isExpired) {
    container.innerHTML = '<div class="status-label status-expired">✘ 授权已到期</div>' +
      '<div>您的授权已于 ' + (status.expiryTime || status.expiry) + ' 到期</div>' +
      '<div class="status-days">请联系客服购买新激活码继续使用</div>';
  } else if (status.activated) {
    container.innerHTML = '<div class="status-label status-active">✓ 已激活（' + status.planName + '）</div>' +
      '<div>到期时间：' + (status.expiryTime || status.expiry) + '</div>' +
      '<div class="status-days">剩余 ' + status.daysLeft + ' 天</div>';
  } else if (status.onTrial && !status.isExpired) {
    container.innerHTML = '<div class="status-label">📅 试用期</div>' +
      '<div>到期时间：' + (status.expiryTime || '') + '</div>' +
      '<div>剩余 <strong>' + status.daysLeft + '</strong> 天（共 3 天）</div>';
  } else if (status.onTrial && status.isExpired) {
    container.innerHTML = '<div class="status-label status-expired">✘ 试用已到期</div>' +
      '<div class="status-days">您的 3 天试用已结束，请联系客服购买激活码继续使用</div>';
  } else {
    container.innerHTML = '<div class="status-label status-expired">✘ 未激活</div>' +
      '<div class="status-days">请输入激活码或免费试用</div>';
  }
}

// 更新 Header 上的授权状态标签
function updateLicenseBadge() {
  var badge = document.getElementById('licenseBadge');
  if (!badge) return;
  var status = getLicenseStatus();

  if (status.activated && !status.isExpired) {
    badge.className = 'license-badge';
    badge.textContent = '📅 ' + status.planName;
    badge.title = '到期时间 ' + (status.expiryTime || status.expiry);
  } else if (status.activated && status.isExpired) {
    badge.className = 'license-badge';
    badge.textContent = '✘ 已到期';
    badge.title = '已于 ' + (status.expiryTime || status.expiry) + ' 到期';
  } else if (status.onTrial && !status.isExpired) {
    badge.className = 'license-badge';
    badge.textContent = '📅 试用';
    badge.title = '到期时间 ' + (status.expiryTime || '');
  } else {
    badge.className = 'license-badge hidden';
  }
}

// 激活按钮事件（由 DOMContentLoaded 绑定）
function bindActivationEvents() {
  var submitBtn = document.getElementById('activationSubmitBtn');
  if (submitBtn) submitBtn.addEventListener('click', function() {
    var key = document.getElementById('activationKeyInput').value.trim();
    if (!key) { showToast('请输入激活码', 'error'); return; }
    var result = activateLicense(key);
    if (result.valid) {
      showToast('🎉 ' + result.message, 'success');
      setTimeout(function() { location.reload(); }, 800);
    } else {
      showToast(result.message || '激活失败', 'error');
    }
  });

  var trialBtn = document.getElementById('activationTrialBtn');
  if (trialBtn) trialBtn.addEventListener('click', function() {
    var status = getLicenseStatus();
    if (status.onTrial && status.isExpired) {
      showToast('试用已结束，请购买激活码', 'error');
      return;
    }
    if (status.activated) {
      showToast('已激活，无需试用', 'info');
      return;
    }
    startTrial();
    showToast('🎉 已开启 3 天免费试用', 'success');
    setTimeout(function() { location.reload(); }, 800);
  });

  // 回车键激活
  var keyInput = document.getElementById('activationKeyInput');
  if (keyInput) keyInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { submitBtn && submitBtn.click(); }
  });
}

// DOMContentLoaded 初始化
document.addEventListener('DOMContentLoaded', function() {
  // ========== 绑定激活界面事件（始终执行） ==========
  bindActivationEvents();

  // ========== 基础加载（授权检查之前执行，确保到期后版本号和主题仍正常） ==========
  loadVersion();
  loadTheme();

  // ========== 授权检查 ==========
  if (!checkAccess()) {
    showActivationScreen();
    return; // 未授权，不加载后续应用
  }
  // 更新授权状态标签
  updateLicenseBadge();
  // API 配置迁移（旧配置 → profiles）
  migrateOldConfig();
  // 迁移旧版模型名
  migrateDeprecatedModelNames();
  // 初始化 header 快速切换标签
  var activeP = getActiveProfile();
  var quickLabel = document.getElementById('profileQuickLabel');
  if (quickLabel) quickLabel.textContent = '🤖 ' + (activeP ? (activeP.model || '未设置') : '未设置');

  // ========== 设置弹窗 ==========
  var settingsBtn = document.getElementById('settingsBtn');
  var modalOverlay = document.getElementById('modalOverlay');
  var modalClose = document.getElementById('modalClose');
  var modalCancel = document.getElementById('modalCancel');
  var modalSave = document.getElementById('modalSave');

  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  if (modalClose) modalClose.addEventListener('click', closeSettingsModal);
  if (modalCancel) modalCancel.addEventListener('click', closeSettingsModal);
  if (modalSave) modalSave.addEventListener('click', saveSettings);
  if (modalOverlay) modalOverlay.addEventListener('click', function(e) {
    if (e.target === this) closeSettingsModal();
  });

  // 提供商切换自动填充
  var apiProvider = document.getElementById('apiProvider');
  if (apiProvider) apiProvider.addEventListener('change', function() {
    var provider = API_PROVIDERS[this.value];
    if (provider && this.value !== 'custom') {
      document.getElementById('apiBaseUrl').value = provider.baseUrl;
      if (provider.model) {
        document.getElementById('modelName').value = provider.model;
      }
    }
  });

  // ========== API 配置管理 ==========
  var profileSelector = document.getElementById('profileSelector');
  if (profileSelector) profileSelector.addEventListener('change', function() {
    fillProfileForm(this.value);
  });

  var profileDeleteBtn = document.getElementById('profileDeleteBtn');
  if (profileDeleteBtn) profileDeleteBtn.addEventListener('click', function() {
    var profiles = loadApiProfiles();
    if (profiles.length <= 1) { showToast('至少保留一个配置', 'error'); return; }
    var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    var idx = profiles.findIndex(function(p) { return p.id === activeId; });
    if (idx === -1) return;
    profiles.splice(idx, 1);
    saveApiProfiles(profiles);
    // 激活列表中第一个配置
    var nextProfile = profiles[0];
    localStorage.setItem(ACTIVE_PROFILE_KEY, nextProfile.id);
    API_CONFIG.baseUrl = nextProfile.baseUrl;
    API_CONFIG.apiKey = nextProfile.apiKey;
    API_CONFIG.model = nextProfile.model;
    renderProfileSelector();
    fillProfileForm(nextProfile.id);
    var label = document.getElementById('profileQuickLabel');
    if (label) label.textContent = '🤖 ' + (nextProfile.model || '未设置');
    showToast('已删除', 'info');
  });

  // ========== Header 快速切换 ==========
  var profileQuickBtn = document.getElementById('profileQuickBtn');
  var profileQuickMenu = document.getElementById('profileQuickMenu');
  if (profileQuickBtn && profileQuickMenu) {
    profileQuickBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      renderQuickMenu();
      profileQuickMenu.classList.toggle('hidden');
    });
    // 点击菜单项由 renderQuickMenu 内部绑定
  }
  // 点击页面其它区域关闭菜单
  document.addEventListener('click', function() {
    var menu = document.getElementById('profileQuickMenu');
    if (menu) menu.classList.add('hidden');
  });

  // ========== 暗色模式切换 ==========
  var themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

  // ========== 审核按钮 ==========
  var startBtn = document.getElementById('startBtn');
  var clearBtn = document.getElementById('clearBtn');
  var retryBtn = document.getElementById('retryBtn');

  if (startBtn) startBtn.addEventListener('click', startReview);
  if (clearBtn) clearBtn.addEventListener('click', clearAll);
  if (retryBtn) retryBtn.addEventListener('click', retryReview);

  // ========== 结果操作 ==========
  var copyMdBtn = document.getElementById('copyMdBtn');
  var downloadMdBtn = document.getElementById('downloadMdBtn');

  if (copyMdBtn) copyMdBtn.addEventListener('click', copyMarkdown);
  if (downloadMdBtn) downloadMdBtn.addEventListener('click', downloadMarkdown);

  var backToMainBtn = document.getElementById('backToMainBtn');
  if (backToMainBtn) backToMainBtn.addEventListener('click', backToMain);

  var compareToggleBtn = document.getElementById('compareToggleBtn');
  if (compareToggleBtn) compareToggleBtn.addEventListener('click', toggleCompare);

  // ========== 历史弹窗 ==========
  var historyBtn = document.getElementById('historyBtn');
  var historyOverlay = document.getElementById('historyOverlay');
  var historyClose = document.getElementById('historyClose');
  var clearHistoryBtn = document.getElementById('clearHistoryBtn');

  if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
  if (historyClose) historyClose.addEventListener('click', closeHistoryModal);
  if (historyOverlay) historyOverlay.addEventListener('click', function(e) {
    if (e.target === this) closeHistoryModal();
  });
  if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', clearAllHistory);

  // 历史筛选条件变化时重新渲染
  var historySearch = document.getElementById('historySearch');
  var historyTypeFilter = document.getElementById('historyTypeFilter');
  var historyDateFilter = document.getElementById('historyDateFilter');
  if (historySearch) historySearch.addEventListener('input', function() { renderHistory(); });
  if (historyTypeFilter) historyTypeFilter.addEventListener('change', function() { renderHistory(); });
  if (historyDateFilter) historyDateFilter.addEventListener('change', function() { renderHistory(); });

  // ========== 数据导出/导入 ==========
  var exportDataBtn = document.getElementById('exportDataBtn');
  var importDataBtn = document.getElementById('importDataBtn');
  var importDataInput = document.getElementById('importDataInput');
  if (exportDataBtn) exportDataBtn.addEventListener('click', exportAllData);
  if (importDataBtn) importDataBtn.addEventListener('click', function() {
    if (importDataInput) importDataInput.click();
  });
  if (importDataInput) importDataInput.addEventListener('change', function(e) {
    if (e.target.files[0]) importAllData(e.target.files[0]);
    this.value = '';
  });

  // ========== 质量趋势看板 ==========
  var dashboardBtn = document.getElementById('dashboardBtn');
  var dashboardOverlay = document.getElementById('dashboardOverlay');
  var dashboardClose = document.getElementById('dashboardClose');
  var dashboardCancel = document.getElementById('dashCancel');
  var dashExportReportBtn = document.getElementById('dashExportReportBtn');
  var dashExportCsvBtn = document.getElementById('dashExportCsvBtn');

  if (dashboardBtn) dashboardBtn.addEventListener('click', openDashboardModal);
  if (dashboardClose) dashboardClose.addEventListener('click', closeDashboardModal);
  if (dashboardCancel) dashboardCancel.addEventListener('click', closeDashboardModal);
  if (dashboardOverlay) dashboardOverlay.addEventListener('click', function(e) {
    if (e.target === this) closeDashboardModal();
  });
  if (dashExportReportBtn) dashExportReportBtn.addEventListener('click', exportDashboardReport);
  if (dashExportCsvBtn) dashExportCsvBtn.addEventListener('click', exportDashboardCsv);

  // 快速筛选按钮
  document.querySelectorAll('.dash-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.dash-filter-btn').forEach(function(b) {
        b.classList.remove('dash-filter-btn--active');
      });
      this.classList.add('dash-filter-btn--active');
      if (this.dataset.range === 'all') {
        document.getElementById('dashDateStart').value = '';
        document.getElementById('dashDateEnd').value = '';
      } else {
        var days = parseInt(this.dataset.range);
        var endDate = new Date();
        var startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        document.getElementById('dashDateStart').value = startDate.toISOString().slice(0, 10);
        document.getElementById('dashDateEnd').value = '';
      }
      _renderDashboard();
    });
  });

  // 日期变化自动刷新
  var dashDateStart = document.getElementById('dashDateStart');
  var dashDateEnd = document.getElementById('dashDateEnd');
  if (dashDateStart) dashDateStart.addEventListener('change', _renderDashboard);
  if (dashDateEnd) dashDateEnd.addEventListener('change', _renderDashboard);

  // ========== 字数统计 ==========
  var docContent = document.getElementById('docContent');
  if (docContent) docContent.addEventListener('input', function() {
    var count = document.getElementById('charCount');
    if (count) count.textContent = this.value.length;
  });

  // ========== 语料库 ==========
  var corpusBtn = document.getElementById('corpusBtn');
  var corpusOverlay = document.getElementById('corpusOverlay');
  var corpusClose = document.getElementById('corpusClose');
  var corpusCancel = document.getElementById('corpusCancel');
  var corpusSave = document.getElementById('corpusSave');
  var addCorpusBtn = document.getElementById('addCorpusBtn');

  if (corpusBtn) corpusBtn.addEventListener('click', openCorpusModal);
  if (corpusClose) corpusClose.addEventListener('click', closeCorpusModal);
  if (corpusCancel) corpusCancel.addEventListener('click', function() {
    window._corpusTempData = null;
    closeCorpusModal();
  });
  if (corpusSave) corpusSave.addEventListener('click', saveCorpusFromModal);
  if (addCorpusBtn) addCorpusBtn.addEventListener('click', function() {
    addCorpusItem();
  });

  // 语料库 tab 切换
  document.querySelectorAll('.corpus-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.corpus-tab').forEach(function(t) {
        t.classList.toggle('corpus-tab--active', t === tab);
      });
      _currentCorpusTab = this.dataset.type;
      renderCorpusItems();
    });
  });

  var clearCorpusBtn = document.getElementById('clearCorpusBtn');
  if (clearCorpusBtn) clearCorpusBtn.addEventListener('click', clearAllCorpus);

  if (corpusOverlay) corpusOverlay.addEventListener('click', function(e) {
    if (e.target === this) {
      window._corpusTempData = null;
      closeCorpusModal();
    }
  });

  // 初始化语料数据（预加载）
  loadCorpus();

  // ========== 键盘快捷键 ==========
  document.addEventListener('keydown', function(e) {
    // Ctrl+Enter / Cmd+Enter → 开始审稿
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      var startBtn = document.getElementById('startBtn');
      if (startBtn && !startBtn.disabled) startBtn.click();
    }
    // Esc → 关闭弹窗
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay--active').forEach(function(el) {
        el.classList.remove('modal-overlay--active');
      });
    }
  });

  // ========== 页面刷新恢复审核结果（sessionStorage）==========
  var savedResult = sessionStorage.getItem('last_review_result');
  if (savedResult) {
    currentRawMarkdown = savedResult;
    document.getElementById('markdownOutput').innerHTML = marked.parse(savedResult, { breaks: true, gfm: true, async: false });
    document.getElementById('resultEmpty').classList.add('hidden');
    document.getElementById('resultContent').classList.remove('hidden');
  }

  // ========== 定期到期检查（每5分钟） ==========
  setInterval(function() {
    if (!checkAccess()) {
      showActivationScreen();
      showToast('您的授权已到期，请购买新激活码', 'error');
    }
  }, 5 * 60 * 1000);
});

// ========== 加载步骤控制 ==========
function resetLoadingSteps() {
  for (var i = 1; i <= 4; i++) {
    var el = document.getElementById('step' + i);
    if (el) {
      el.classList.remove('active', 'done');
    }
  }
}

function setStepActive(num) {
  for (var i = 1; i <= 4; i++) {
    var el = document.getElementById('step' + i);
    if (el) {
      el.classList.remove('active', 'done');
      if (i < num) el.classList.add('done');
      if (i === num) el.classList.add('active');
    }
  }
}

// 回退读取：以文本方式读取文件（用于 .doc 等二进制格式的 fallback）
function fallbackReadText(file) {
  var r = new FileReader();
  r.onload = function(ev) {
    var text = ev.target.result || '';
    document.getElementById('docContent').value = text;
    document.getElementById('charCount').textContent = text.length;
    showToast('已以文本方式加载: ' + file.name + '（' + text.length + '字，部分格式可能不完整）', text.length > 0 ? 'info' : 'error');
    _lastFileName = file.name;
  };
  r.onerror = function() {
    showToast('无法读取文件: ' + file.name, 'error');
  };
  r.readAsText(file, 'UTF-8');
}

// 处理上传文件（点击 / 拖拽共用）
function handleUploadFile(file) {
  if (!file) return;
  var ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    var reader = new FileReader();
    reader.onload = function(ev) {
      var text = ev.target.result;
      document.getElementById('docContent').value = text;
      document.getElementById('charCount').textContent = text.length;
      showToast('已加载: ' + file.name + '（' + text.length + '字）', 'success');
    };
    reader.readAsText(file, 'UTF-8');
  } else if (ext === '.docx' || ext === '.wps' || ext === '.wpt') {
    if (typeof mammoth === 'undefined') {
      showToast('文档解析库未加载，请检查网络', 'error');
      return;
    }
    // 文件大小预警
    var fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > 3) {
      showToast('文件较大（' + fileSizeMB.toFixed(1) + 'MB），正在解析…解析后若字数过多将自动分段审核', 'info');
    }
    var reader = new FileReader();
    reader.onload = function(ev) {
      mammoth.extractRawText({ arrayBuffer: ev.target.result })
        .then(function(result) {
          var extractedText = result.value || '(空文档)';
          document.getElementById('docContent').value = extractedText;
          document.getElementById('charCount').textContent = extractedText.length;
          var warnMsg = '';
          if (extractedText.length > 15000) warnMsg = '，字数较多可分段';
          else if (extractedText.length > 8000) warnMsg = '，内容较长';
          showToast('已加载: ' + file.name + '（' + extractedText.length + '字' + warnMsg + '）', extractedText.length > 15000 ? 'warning' : 'success');
          _lastFileName = file.name;
        })
        .catch(function(err) {
          showToast('解析文档失败: ' + (err.message || '格式不支持'), 'error');
        });
    };
    reader.readAsArrayBuffer(file);
  } else if (ext === '.doc') {
    // .doc 旧格式：先尝试 mammoth（WPS 生成的 .doc 有时为 OOXML），失败则回退到文本读取
    if (typeof mammoth !== 'undefined') {
      var reader2 = new FileReader();
      reader2.onload = function(ev) {
        mammoth.extractRawText({ arrayBuffer: ev.target.result })
          .then(function(result) {
            var extractedText = result.value || '(空文档)';
            document.getElementById('docContent').value = extractedText;
            document.getElementById('charCount').textContent = extractedText.length;
            showToast('已加载: ' + file.name + '（' + extractedText.length + '字）', 'success');
            _lastFileName = file.name;
          })
          .catch(function() {
            // mammoth 失败 → 回退文本读取
            fallbackReadText(file);
          });
      };
      reader2.readAsArrayBuffer(file);
    } else {
      fallbackReadText(file);
    }
  } else {
    showToast('不支持的格式: ' + ext, 'error');
  }
}

// 上传文档到输入框
document.addEventListener('DOMContentLoaded', function() {
  var uploadBtn = document.getElementById('uploadDocBtn');
  if (uploadBtn) uploadBtn.addEventListener('click', function() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.docx,.doc,.wps,.wpt';
    input.addEventListener('change', function(e) {
      handleUploadFile(e.target.files[0]);
    });
    input.click();
  });

  // 拖拽上传
  var dropZone = document.querySelector('.upload-doc-group');
  if (dropZone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventType) {
      dropZone.addEventListener(eventType, function(e) {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    dropZone.addEventListener('dragenter', function() {
      dropZone.classList.add('upload-doc-group--dragover');
    });

    dropZone.addEventListener('dragleave', function(e) {
      if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('upload-doc-group--dragover');
      }
    });

    dropZone.addEventListener('drop', function(e) {
      dropZone.classList.remove('upload-doc-group--dragover');
      var files = e.dataTransfer.files;
      if (files.length > 0) {
        handleUploadFile(files[0]);
      }
    });
  }
});

// HTML 转义
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Toast 提示
function showToast(message, type) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast toast--active toast--' + (type || 'info');
  clearTimeout(toast._hideTimer);
  var duration = (type === 'error' || type === 'warning') ? 5000 : 3000;
  toast._hideTimer = setTimeout(function() {
    toast.classList.remove('toast--active');
  }, duration);
}

// ========== 防拷贝保护 ==========

// 1. 页面级别禁止选择，但允许审核结果区域
document.addEventListener('selectstart', function(e) {
  var target = e.target;
  var allowSelect = target.closest('#resultContent') ||
                    target.closest('.result-content-area') ||
                    target.closest('input') ||
                    target.closest('textarea') ||
                    target.closest('select');
  if (!allowSelect) {
    e.preventDefault();
  }
});

// 2. 禁止开发者工具快捷键
document.addEventListener('keydown', function(e) {
  // F12
  if (e.key === 'F12' || e.keyCode === 123) {
    e.preventDefault();
    return false;
  }

  // Ctrl+Shift+I/C/J (DevTools)
  if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' ||
      e.key === 'J' || e.key === 'j' ||
      e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    return false;
  }

  // Ctrl+U (查看源代码)
  if (e.ctrlKey && (e.key === 'U' || e.key === 'u')) {
    e.preventDefault();
    return false;
  }

  // Ctrl+S (保存页面)
  if (e.ctrlKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault();
    return false;
  }

  // Ctrl+A (全选页面) — 允许在输入框/文本域内全选
  if (e.ctrlKey && (e.key === 'A' || e.key === 'a')) {
    var tag = e.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      return false;
    }
  }

  // Ctrl+C 审核结果区域放行
  if (e.ctrlKey && (e.key === 'C' || e.key === 'c')) {
    var selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      var node = selection.getRangeAt(0).commonAncestorContainer;
      var el = node.nodeType === 3 ? node.parentNode : node;
      if (el && (el.closest('#resultContent') ||
                 el.closest('input') ||
                 el.closest('textarea'))) {
        return true;
      }
    }
    e.preventDefault();
    return false;
  }
});

// 3. DevTools 打开检测
(function detectDevTools() {
  var threshold = 160;
  var check = function() {
    var widthThreshold = window.outerWidth - window.innerWidth > threshold;
    var heightThreshold = window.outerHeight - window.innerHeight > threshold;
    if (widthThreshold || heightThreshold) {
      var overlay = document.getElementById('devtools-warning');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'devtools-warning';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-family:sans-serif;';
        overlay.innerHTML = '<div style="text-align:center;padding:40px;"><div style="font-size:48px;margin-bottom:20px;">🔒</div><div>请关闭开发者工具以继续使用</div><div style="font-size:14px;color:#999;margin-top:12px;">本页面受保护，请勿进行调试操作</div></div>';
        document.body.appendChild(overlay);
      }
      overlay.style.display = 'flex';
    } else {
      var overlay = document.getElementById('devtools-warning');
      if (overlay) overlay.style.display = 'none';
    }
  };
  setInterval(check, 2000);
  window.addEventListener('resize', check);
})();

// 4. 反调试：控制台版权声明
(function() {
  var style = 'font-size:20px;color:#1a5276;font-weight:bold;';
  console.log('%c⚠️ 警告：此页面受保护，请勿进行调试操作', style);
  console.log('%c未经授权复制或修改代码将承担法律责任', 'font-size:14px;color:#999;');
})();