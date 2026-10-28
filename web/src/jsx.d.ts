// Typora wraps the editor in a custom <content> element; themes select it by tag.
import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      content: HTMLAttributes<HTMLElement>;
    }
  }
}
