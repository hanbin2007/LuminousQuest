declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.woff2' {
  const url: string;
  export default url;
}

// vite define 注入的构建身份(测试等未注入环境下访问前须 typeof 判空)
declare const __LQ_BUILD_INFO__: {
  commit: string;
  dirty: boolean;
  builtAt: string;
} | undefined;
