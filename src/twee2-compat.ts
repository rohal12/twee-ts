/**
 * Twee2 to Twee3 header syntax conversion.
 * Ported from twee2compat.go.
 */

const twee2DetectRe = /^:: *[^[]*?(?: *\[.*?\])? *<(.*?)> *$/m;
const twee2HeaderRe = /^(:: *[^[]*?)( *\[.*?\])?(?: *<(.*?)>)? *$/gm;
const twee2BadPosRe = /^(::.*?) *\{"position":" *"\}$/gm;

function hasTwee2Syntax(s: string): boolean {
  return twee2DetectRe.test(s);
}

/**
 * Convert Twee2-style position blocks `<x,y>` to Twee3 metadata blocks `{"position":"x,y"}`.
 */
export function twee2ToV3(s: string): string {
  if (!hasTwee2Syntax(s)) return s;
  s = s.replace(twee2HeaderRe, (_, p1: string, p2: string | undefined, p3: string | undefined) => {
    const tags = p2 ?? '';
    const pos = p3 ?? '';
    return `${p1}${tags} {"position":"${pos}"}`;
  });
  s = s.replace(twee2BadPosRe, '$1');
  return s;
}
