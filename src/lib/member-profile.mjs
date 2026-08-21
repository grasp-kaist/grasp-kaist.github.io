/**
 * Return only profiles that explicitly opt into the public Members listing.
 * Missing `listed` fields stay hidden; the validator catches that invalid
 * shape before a production build.
 *
 * @template {{ listed?: unknown }} T
 * @param {T[]} profiles
 * @returns {T[]}
 */
export function getListedMembers(profiles) {
  return profiles.filter((profile) => profile.listed === true);
}

/**
 * Convert the free-form website field into safe display text and, when
 * possible, a normal HTTP(S) link. Invalid or unsupported values are returned
 * as text only so Astro can escape and display them without creating a link.
 *
 * @param {unknown} value
 * @returns {{ text: string, href?: string } | undefined}
 */
export function getWebsitePresentation(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.trim();

  if (!text) {
    return undefined;
  }

  const explicitHttpUrl = /^https?:\/\//i.test(text);
  const hasOtherScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !explicitHttpUrl;

  if (hasOtherScheme || text.startsWith('//')) {
    return { text };
  }

  const candidate = explicitHttpUrl ? text : `https://${text}`;

  try {
    const url = new URL(candidate);

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !url.hostname
      || url.username
      || url.password
    ) {
      return { text };
    }

    if (!explicitHttpUrl && !isLikelyBareDomain(url.hostname, text)) {
      return { text };
    }

    return {
      href: url.href,
      text: explicitHttpUrl ? text : `https://${text}`,
    };
  } catch {
    return { text };
  }
}

/**
 * Avoid interpreting arbitrary prose as a hostname simply because URL accepts
 * it. Public profile links should at least look like a dotted domain or IP.
 *
 * @param {string} hostname
 * @param {string} original
 */
function isLikelyBareDomain(hostname, original) {
  if (/\s/.test(original) || original.includes('@')) {
    return false;
  }

  if (hostname.includes('.')) {
    return true;
  }

  return hostname.startsWith('[') && hostname.endsWith(']');
}
