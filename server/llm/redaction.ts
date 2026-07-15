import { hashValue } from './cache-key';

export type RecordingRedactor = (value: unknown) => unknown;

const secretKeyPattern = /^(authorization|api[-_]?key|secret|token|access[-_]?token|refresh[-_]?token|cookie|set-cookie)$/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const phonePattern = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const identifierPattern = /(?<!\d)\d{15,18}[\dXx]?(?!\d)/g;
const qqPattern = /(?:QQ|企鹅号)\s*[:：号]?\s*[1-9]\d{4,11}/giu;
const wechatPattern = /(?:微信(?:号)?|WeChat)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]{5,19}/giu;
const studentIdPattern = /(?:学号|学生编号)\s*[:：]?\s*[A-Za-z0-9-]{4,20}/gu;
const addressPattern = /(?:地址|住址)\s*[:：]?\s*[^\s,，。;；]{4,80}/gu;
const schoolClassPattern = /[^\s,，。;；]{2,40}(?:高[一二三123]|初[一二三123]|[一二三四五六123456]年级)[(（]?\d{1,2}[)）]?班/gu;

export function redactPersonalText(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(emailPattern, '[REDACTED_EMAIL]')
      .replace(phonePattern, '[REDACTED_PHONE]')
      .replace(identifierPattern, '[REDACTED_ID]')
      .replace(qqPattern, '[REDACTED_QQ]')
      .replace(wechatPattern, '[REDACTED_WECHAT]')
      .replace(studentIdPattern, '[REDACTED_STUDENT_ID]')
      .replace(addressPattern, '[REDACTED_ADDRESS]')
      .replace(schoolClassPattern, '[REDACTED_SCHOOL_CLASS]');
  }
  if (Array.isArray(value)) return value.map(redactPersonalText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, redactPersonalText(entry)]),
    );
  }
  return value;
}

export const defaultRecordingRedactor: RecordingRedactor = (value) => {
  function visit(entry: unknown, parentKey = ''): unknown {
    if (secretKeyPattern.test(parentKey)) return '[REDACTED]';
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      if (
        typeof object.data === 'string' &&
        typeof object.mediaType === 'string' &&
        object.mediaType.startsWith('image/')
      ) {
        return {
          ...Object.fromEntries(
            Object.entries(object)
              .filter(([key]) => key !== 'data')
              .map(([key, item]) => [key, visit(item, key)]),
          ),
          data: `[IMAGE SHA256:${hashValue(object.data)}]`,
        };
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => [key, visit(item, key)]),
      );
    }
    return entry;
  }

  return visit(value);
};
