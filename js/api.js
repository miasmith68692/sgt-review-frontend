// ========== API Profile Management ==========

var PROFILES_KEY = 'api_profiles';
var ACTIVE_PROFILE_KEY = 'active_profile_id';

// 加载所有配置
function loadApiProfiles() {
  try {
    var data = localStorage.getItem(PROFILES_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
}

// 保存所有配置
function saveApiProfiles(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

// 生成短 ID
function genProfileId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
}

// 获取当前激活的配置
function getActiveProfile() {
  var profiles = loadApiProfiles();
  var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  var found = null;
  if (activeId) {
    found = profiles.find(function(p) { return p.id === activeId; });
  }
  return found || profiles[0] || null;
}

// 切换激活配置
function setActiveProfile(profileId, updateLabel) {
  var profiles = loadApiProfiles();
  var profile = profiles.find(function(p) { return p.id === profileId; });
  if (!profile) return false;
  localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
  // 更新 API_CONFIG
  API_CONFIG.baseUrl = profile.baseUrl;
  API_CONFIG.apiKey = profile.apiKey;
  API_CONFIG.model = profile.model;
  // 更新 header 标签
  if (updateLabel !== false) {
    var label = document.getElementById('profileQuickLabel');
    if (label) label.textContent = '🤖 ' + (profile.model || '未设置');
  }
  return true;
}

// 迁移旧配置
function migrateOldConfig() {
  var profiles = loadApiProfiles();
  if (profiles.length > 0) return; // 已有 profile，跳过
  var oldBaseUrl = localStorage.getItem('api_base_url');
  var oldApiKey = localStorage.getItem('api_key');
  var oldModel = localStorage.getItem('api_model');
  var oldProvider = localStorage.getItem('api_provider');
  if (!oldBaseUrl && !oldApiKey && !oldModel) return; // 无旧配置
  var profile = {
    id: genProfileId(),
    name: '默认配置',
    provider: oldProvider || 'custom',
    baseUrl: oldBaseUrl || 'https://api.deepseek.com',
    apiKey: oldApiKey || '',
    model: oldModel || 'deepseek-v4-flash',
    createdAt: new Date().toISOString().slice(0, 10)
  };
  profiles.push(profile);
  saveApiProfiles(profiles);
  localStorage.setItem(ACTIVE_PROFILE_KEY, profile.id);
  // 清理旧 key
  localStorage.removeItem('api_base_url');
  localStorage.removeItem('api_key');
  localStorage.removeItem('api_model');
  localStorage.removeItem('api_provider');
}

// 迁移旧版模型名（如 deepseek-chat → deepseek-v4-flash）
function migrateDeprecatedModelNames() {
  var profiles = loadApiProfiles();
  var changed = false;
  profiles.forEach(function(p) {
    if (p.model === 'deepseek-chat') {
      p.model = 'deepseek-v4-flash';
      changed = true;
    }
  });
  if (changed) {
    saveApiProfiles(profiles);
    // 同步更新当前 API_CONFIG
    var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    var active = profiles.find(function(p) { return p.id === activeId; });
    if (active) {
      API_CONFIG.model = active.model;
    }
  }
}

// ========== LLM API 配置 ==========

var activeProfile = getActiveProfile();
var API_CONFIG = {
  baseUrl: activeProfile ? activeProfile.baseUrl : 'https://api.deepseek.com',
  apiKey: activeProfile ? activeProfile.apiKey : '',
  model: activeProfile ? activeProfile.model : 'deepseek-v4-flash',
  temperature: 0.3
};

// 保存 API 配置（更新当前活跃 profile）
function saveApiConfig(config) {
  var profiles = loadApiProfiles();
  var activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  var profile = profiles.find(function(p) { return p.id === activeId; });
  if (!profile) {
    // 无活跃 profile 则创建
    profile = {
      id: genProfileId(),
      name: config.name || '默认配置',
      provider: config.provider || 'custom',
      baseUrl: config.baseUrl || 'https://api.deepseek.com',
      apiKey: config.apiKey || '',
      model: config.model || 'deepseek-v4-flash',
      createdAt: new Date().toISOString().slice(0, 10)
    };
    profiles.push(profile);
    localStorage.setItem(ACTIVE_PROFILE_KEY, profile.id);
  } else {
    if (config.name !== undefined) profile.name = config.name;
    if (config.provider !== undefined) profile.provider = config.provider;
    if (config.baseUrl) profile.baseUrl = config.baseUrl;
    if (config.apiKey !== undefined) profile.apiKey = config.apiKey;
    if (config.model !== undefined) profile.model = config.model;
  }
  saveApiProfiles(profiles);
  // 更新 API_CONFIG
  API_CONFIG.baseUrl = profile.baseUrl;
  API_CONFIG.apiKey = profile.apiKey;
  API_CONFIG.model = profile.model;
  return true;
}

// 模型名映射（兼容旧版名称）
var MODEL_NAME_MAP = {
  'deepseek-chat': 'deepseek-v4-flash'
};

// ========== LLM API 调用 ==========

async function callLLM(messages, options = {}) {
  var modelName = options.model || API_CONFIG.model;
  // 自动映射旧版模型名
  if (MODEL_NAME_MAP[modelName]) {
    modelName = MODEL_NAME_MAP[modelName];
  }
  const url = `${API_CONFIG.baseUrl}/v1/chat/completions`;

  // 检查 API Key 是否包含非法字符
  var apiKey = API_CONFIG.apiKey || '';
  var apiKeyValid = /^[\x20-\x7E]+$/.test(apiKey);
  if (!apiKeyValid) {
    throw new Error('API密钥含有非法字符，请在设置中重新输入API Key（仅支持字母、数字和符号）');
  }

  // 检查 API 地址是否包含非法字符
  if (API_CONFIG.baseUrl && !/^[\x20-\x7E]+$/.test(API_CONFIG.baseUrl)) {
    throw new Error('API地址含有非法字符，请在设置中重新输入API地址');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey
  };
  const body = JSON.stringify({
    model: modelName,
    messages: messages,
    temperature: options.temperature || API_CONFIG.temperature,
    max_tokens: options.maxTokens || 16000,
    stream: false
  });

  var response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    });
  } catch (fetchError) {
    // 捕获 fetch 协议错误（非ISO-8859-1字符等）
    throw new Error('网络请求失败：' + fetchError.message + '。请检查API地址和密钥是否正确');
  }

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error('API请求失败 (' + response.status + '): ' + errorData);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// 稿件分类
async function classifyDocument(content) {
  const prompt = PROMPTS.classify.replace('{content}', content);
  const response = await callLLM([
    { role: 'user', content: prompt }
  ], { temperature: 0.1 });
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { type: '未知', confidence: 0, reason: '无法解析分类结果' };
  } catch (e) {
    return { type: '未知', confidence: 0, reason: response };
  }
}

// 全文审稿
async function reviewDocument(content, documentType) {
  const prompts = (typeof getCorpusPrompt === 'function') ? getCorpusPrompt() : { rule: '', corpus: '' };

  const systemPrompt = `你是一位资深的国资央企文字审核专家，精通各类公文材料的审核把关工作。你的工作标准极高，注重每一个细节。在回答时，直接输出审核结果，不要展示任何思考过程或分析推理。${prompts.rule}${prompts.corpus}`;

  const prompt = PROMPTS.review(documentType).replace('{content}', content);
  
  const response = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ], { temperature: 0.3, maxTokens: 16000 });

  return response;
}

// 一键全流程审稿（分类 + 审核）
async function fullReview(content) {
  const classifyResult = await classifyDocument(content);
  const docType = classifyResult.type || '通用文稿';
  
  const reviewResult = await reviewDocument(content, docType);
  
  return {
    documentType: docType,
    typeConfidence: classifyResult.confidence,
    reviewResult: reviewResult
  };
}