/**
 * What the HTML over the canvas did, frame by frame.
 *
 * The scene itself has now been measured properly — 30 s of framebuffer reads
 * in both modes, two to eleven changed cells out of sixteen thousand, no
 * spikes, no alternation, flat 120 fps. The office is not what is flashing, and
 * three fixes aimed at it were aimed at nothing.
 *
 * What `readPixels` cannot see is everything drawn *over* the canvas: the
 * nameplates, which are drei `Html` portals moved by a transform every frame,
 * the hover card, and the chrome. So this does the same job in the DOM: each
 * frame, take the visual style of every element in the overlay, and diff.
 *
 * The useful part is not the change count but the *shape* of the change. An
 * element easing to a new position takes a different value every frame and
 * never repeats. An element that is flashing has two values and sits between
 * them. So every element's values are counted, and one that spends a run of
 * frames alternating between exactly two of them is reported as such — which is
 * a diagnosis rather than a hint.
 */

const WATCHED = ['transform', 'opacity', 'visibility', 'display', 'left', 'top', 'color', 'backgroundColor'] as const;

export interface ChurnEntry {
  /** A readable path to the element: tag.class chains from the overlay root. */
  path: string;
  /** Frames on which any watched property differed from the frame before. */
  changes: number;
  /** How many distinct values the element took across the whole recording. */
  distinct: number;
  /** The longest run of frames spent strictly alternating A-B-A-B. */
  longestAlternation: number;
  /** The two values it alternated between, when it did. */
  pair?: [string, string];
  /** A sample of what it looked like, for reading. */
  sample: string;
}

export function recordDomChurn(frames: number): Promise<ChurnEntry[]> {
  return new Promise((resolve) => {
    const history = new Map<string, string[]>();
    let left = frames;

    const step = (): void => {
      // The canvas is measured by the flicker probe; everything else is here.
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        if (element instanceof HTMLCanvasElement) continue;
        const style = element.style;
        const computed = getComputedStyle(element);
        let value = '';
        for (const property of WATCHED) {
          // The inline transform is what drei writes, and reading it off the
          // element is far cheaper than a full computed-style resolve.
          value += `${property}=${style[property] || computed[property]};`;
        }
        const path = pathOf(element);
        const list = history.get(path);
        if (list) list.push(value);
        else history.set(path, [value]);
      }

      left -= 1;
      if (left > 0) requestAnimationFrame(step);
      else resolve(summarise(history));
    };

    requestAnimationFrame(step);
  });
}

function summarise(history: Map<string, string[]>): ChurnEntry[] {
  const entries: ChurnEntry[] = [];

  for (const [path, values] of history) {
    let changes = 0;
    for (let i = 1; i < values.length; i += 1) if (values[i] !== values[i - 1]) changes += 1;
    if (changes === 0) continue;

    const distinct = new Set(values);

    // The longest stretch where value[i] === value[i - 2] but !== value[i - 1]:
    // a strict two-state toggle.
    let longest = 0;
    let run = 0;
    let pair: [string, string] | undefined;
    for (let i = 2; i < values.length; i += 1) {
      if (values[i] === values[i - 2] && values[i] !== values[i - 1]) {
        run += 1;
        if (run > longest) {
          longest = run;
          pair = [values[i - 1] as string, values[i] as string];
        }
      } else {
        run = 0;
      }
    }

    entries.push({
      path,
      changes,
      distinct: distinct.size,
      longestAlternation: longest,
      ...(pair ? { pair } : {}),
      sample: values[values.length - 1] ?? '',
    });
  }

  return entries.sort((a, b) => b.longestAlternation - a.longestAlternation || b.changes - a.changes);
}

function pathOf(element: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = element;
  let depth = 0;
  while (node && node !== document.body && depth < 6) {
    const classes = typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
    // A sibling index, so two nameplates are not reported as one element.
    const parent: HTMLElement | null = node.parentElement;
    const index = parent ? [...parent.children].indexOf(node) : 0;
    parts.unshift(`${node.tagName.toLowerCase()}${classes}[${index}]`);
    node = parent;
    depth += 1;
  }
  return parts.join('>');
}
