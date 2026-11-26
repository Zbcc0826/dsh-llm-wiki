/**
 * 把非法 slug 收成稳定的小写连字符。
 * 中文先转成不带声调的拼音，再和英文一起做 ASCII 折叠。
 */
import { pinyin } from 'pinyin-pro'
import { validSlug } from './pages.js'

/** 和页面校验用的是同一条规则。错误里原样带回，方便对照。 */
export const SLUG_RULE = '^[a-z0-9]+(?:-[a-z0-9]+)*$'

/**
 * 已合法的 slug 保持原样。
 * 不合法时优先用标题，标题也不行再用原始 slug。都变不出合法名字就返回空字符串。
 */
export function resolveSlug(slug, title) {
  if (validSlug(slug)) return slug
  const fromTitle = asciiSlug(spell(title))
  if (validSlug(fromTitle)) return fromTitle
  const fromRaw = asciiSlug(spell(slug))
  if (validSlug(fromRaw)) return fromRaw
  return ''
}

/** 同一补丁里撞名时加序号，避免整份摄入因为兜底重名而失败。 */
export function uniqueSlug(kind, slug, seen) {
  const taken = seen ?? new Set()
  let next = slug
  let index = 2
  while (taken.has(`${kind}/${next}`)) {
    const suffix = `-${index}`
    next = `${slug.slice(0, 60 - suffix.length).replace(/-+$/g, '')}${suffix}`
    index += 1
    if (index > 30 || !validSlug(next)) return ''
  }
  return next
}

/** 含汉字时转拼音；纯英文原样返回，交给后面的折叠。 */
function spell(text) {
  const source = String(text ?? '').trim()
  if (!source) return ''
  if (!/[\u3400-\u9fff]/u.test(source)) return source
  return pinyin(source, { toneType: 'none', type: 'string', nonZh: 'consecutive', v: true })
}

/** 小写、去掉声调符号，非字母数字收成单个连字符，最长 60。 */
function asciiSlug(text) {
  const folded = String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-+$/g, '')
  return slug
}
