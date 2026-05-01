/**
 * DOM parser factory- returns a browser DOMParser or @xmldom/xmldom in Node.js.
 *
 * Environment detection: if `window` and `DOMParser` exist, use the native browser
 * parser. Otherwise, use @xmldom/xmldom for Node.js (test) environments.
 */

import * as xmldom from "@xmldom/xmldom";

export interface XmlDomParser {
  parse(xml: string): Document;
}

/**
 * Create an XmlDomParser appropriate for the current runtime environment.
 *
 * In a browser: wraps the native `DOMParser`.
 * In Node.js: uses `@xmldom/xmldom`'s `DOMParser`.
 */
export function createDomParser(): XmlDomParser {
  if (typeof window !== "undefined" && typeof window.DOMParser === "function") {
    const parser = new window.DOMParser();
    return {
      parse(xml: string): Document {
        return parser.parseFromString(xml, "text/xml");
      },
    };
  }

  // Node.js environment- use @xmldom/xmldom.
  const NodeDOMParser = xmldom.DOMParser as unknown as new () => {
    parseFromString(xml: string, mimeType: string): Document;
  };
  const parser = new NodeDOMParser();
  return {
    parse(xml: string): Document {
      return parser.parseFromString(xml, "text/xml") as Document;
    },
  };
}
