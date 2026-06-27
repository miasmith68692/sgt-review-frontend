/**
 * 审稿通 - 激活码生成工具
 *
 * 使用方法（命令行）：
 *   node tools/generate-key.js <套餐标识> <用户ID>
 *
 * 示例：
 *   node tools/generate-key.js monthly U001
 *   node tools/generate-key.js yearly U002
 *
 * 套餐标识：trial | weekly | halfmonth | monthly | quarterly | halfyear | yearly
 *
 * 注意：此工具仅供卖方使用，请勿泄露 LICENSE_SECRET。
 */

const crypto = require('crypto');

// ========== 配置（必须与 js/license.js 中的 LICENSE_SECRET 一致） ==========
const LICENSE_SECRET = 'sgt_review_secret_key_2026';
// =========================================================================

const PLAN_DAYS = {
  trial: 3,
  weekly: 7,
  halfmonth: 15,
  monthly: 30,
  quarterly: 90,
  halfyear: 180,
  yearly: 365
};

const PLAN_NAMES = {
  trial: '试用',
  weekly: '一周',
  halfmonth: '半月',
  monthly: '月度',
  quarterly: '季度',
  halfyear: '半年',
  yearly: '年度'
};

function toBase64Url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateKey(plan, uid) {
  if (!PLAN_DAYS[plan]) {
    console.error('错误：无效的套餐标识。有效值：' + Object.keys(PLAN_DAYS).join(', '));
    process.exit(1);
  }
  if (!uid || uid.trim() === '') {
    console.error('错误：用户 ID 不能为空');
    process.exit(1);
  }

  var exp = new Date();
  exp.setDate(exp.getDate() + PLAN_DAYS[plan]);

  var payloadObj = {
    plan: plan,
    exp: exp.toISOString().slice(0, 10),
    uid: uid.trim(),
    seed: Math.random().toString(36).substring(2, 8)
  };

  var payload = toBase64Url(JSON.stringify(payloadObj));
  var sig = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('hex');

  var key = payload + '.' + sig;

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  审稿通 - 激活码');
  console.log('═══════════════════════════════════════');
  console.log('  套餐:     ' + PLAN_NAMES[plan] + ' (' + plan + ')');
  console.log('  用户 ID:  ' + uid.trim());
  console.log('  到期日:   ' + payloadObj.exp);
  console.log('  有效天数: ' + PLAN_DAYS[plan] + ' 天');
  console.log('───────────────────────────────────────');
  console.log('  ' + key);
  console.log('═══════════════════════════════════════');
  console.log('');

  return key;
}

// 命令行入口
if (process.argv.length < 4) {
  console.log('用法: node tools/generate-key.js <套餐标识> <用户ID>');
  console.log('套餐标识: ' + Object.keys(PLAN_DAYS).join(', '));
  console.log('示例: node tools/generate-key.js monthly U001');
  process.exit(0);
}

generateKey(process.argv[2], process.argv[3]);