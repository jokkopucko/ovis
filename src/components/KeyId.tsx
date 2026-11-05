import "./KeyId.css";

import { useT } from "../lib/i18n.ts";

/** A relay id in groups of four, the way a person compares two of them aloud. */
export function keyIdGroups(id: string): string[] {
  return id.match(/.{1,4}/g) ?? [];
}

/**
 * A PC's relay id (a SHA-256 of its relay key) as groups to compare by eye. With `against`, each
 * group that differs from the same group of the other id is marked, by weight and an underline as
 * well as colour, and named for a screen reader.
 */
export function KeyId({ id, against, label }: { id: string; against?: string; label: string }) {
  const t = useT();
  const others = against === undefined ? null : keyIdGroups(against);
  return (
    <span className="key-id" role="group" aria-label={label}>
      {keyIdGroups(id).map((group, index) => {
        const differs = others !== null && others[index] !== group;
        return (
          <span key={index} className={differs ? "key-id-group key-id-differs" : "key-id-group"}>
            {group}
            {differs && <span className="visually-hidden">{` ${t("differs")}`}</span>}
          </span>
        );
      })}
    </span>
  );
}
