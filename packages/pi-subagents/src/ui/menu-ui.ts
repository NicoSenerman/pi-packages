/** Narrow UI interface — only the ctx.ui methods menu handlers actually call. */
export interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  editor(title: string, content: string): Promise<string | undefined>;
  custom<R>(component: any, options?: any): Promise<R>;
}
