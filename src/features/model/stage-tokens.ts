/**
 * 暗态 3D 舞台色板——与 tokens.css 的 .stage-dark 保持同源;
 * canvas 内无法读 CSS 变量,此处为唯一镜像点。
 * 独立成轻量模块:让训练页等宿主无需静态引入 three.js 即可取用色值。
 */
export const STAGE = {
  bg: '#0a1526',
  fog: '#101f38',
  glow: { device: '#5b8de8', principle: '#3fe0d8', energy: '#ffb84d' } as const,
  unlit: '#2a3a52',
  unassessed: '#5a636d',
  needsReview: '#e8960c',
  text: '#d7e2ef',
};
