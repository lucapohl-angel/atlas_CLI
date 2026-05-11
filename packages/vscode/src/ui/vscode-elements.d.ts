import type { DetailedHTMLProps, HTMLAttributes, RefAttributes } from 'react';

type VscodeElementProps<T extends HTMLElement> = DetailedHTMLProps<HTMLAttributes<T>, T> & RefAttributes<T> & Record<string, unknown>;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'vscode-button': VscodeElementProps<HTMLElement>;
      'vscode-icon': VscodeElementProps<HTMLElement>;
      'vscode-single-select': VscodeElementProps<HTMLElement>;
      'vscode-option': VscodeElementProps<HTMLElement>;
    }
  }
}

declare module '*.png' {
  const src: string;
  export default src;
}
