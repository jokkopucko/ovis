# Ovis's layout on herdr-core

herdr-core (`hc`) has terminals, labels and documents, but no workspaces, tabs or splits. On a
core no Herdr app arranges (its `herdr-app` document was never written, or was deleted), Ovis
keeps them itself, in the two places below. Any hc client may read them; a client that writes
them keeps to the rules here, so Ovis and it do not undo each other's changes.

Ovis never writes the Herdr app's `herdr-app` document. Where it exists, the app arranges the
core and Ovis only reads it.

## Terminal labels

Which workspace and tab a terminal is in, and the names a person gave, are labels on the
terminal (`hc label`, `terminal.label`; a label set to the empty string is removed):

| Label | Value | Set by |
|---|---|---|
| `herdr.space` | the workspace's id | Ovis, on every terminal it starts; the Herdr app groups by it too |
| `herdr.tab` | the tab's id | Ovis, as above |
| `herdr.seen`, `herdr.pinned` | as the Herdr app's `docs/labels.md` says | every Herdr client |
| `ovis.workspace` | the workspace's name | Ovis, on each terminal of a renamed workspace |
| `ovis.tab` | the tab's name | Ovis, on each terminal of a renamed tab |
| `ovis.pane` | the pane's name (else the terminal's own `name`) | Ovis, on a renamed pane |
| `ovis.opencode` | the OpenCode sessions the terminal reported, newest last, space separated | Ovis, while OpenCode runs there; removed once it is gone |

`ovis.*` labels hold only small facts about one terminal. Nothing else Ovis keeps (approvals,
prompt answers, conversations) is stored in hc.

## The `ovis-layout` document

The order of workspaces and tabs, each tab's splits and the pane it shows alone live in one hc
document, `ovis-layout` (`hc doc get ovis-layout`, `doc.get` / `doc.set`):

```json
{
  "schema": 1,
  "workspaces": [
    { "id": "ovis-3f…", "tabs": [
      { "id": "ovis-9a…", "zoomed": null, "root":
        { "split": "right", "ratio": 0.5,
          "first": { "split": "down", "ratio": 0.5, "first": { "leaf": "t1" }, "second": { "leaf": "t3" } },
          "second": { "leaf": "t2" } } }
    ] }
  ]
}
```

- `workspaces` and each workspace's `tabs` are in display order; `id`s are the `herdr.space` and
  `herdr.tab` label values.
- `root` is a node: `{ "leaf": "<terminal address>" }`, or `{ "split": "right" | "down",
  "ratio": 0.1..0.9, "first": node, "second": node }`. `right` puts `first` on the left, `down`
  puts it on top; `ratio` is `first`'s share.
- `zoomed` is the terminal address the tab shows alone, or `null`.

Labels stay the truth for membership. Every time Ovis reads the core it reconciles the document
with them: a leaf whose terminal is gone or labeled into another tab is dropped (its sibling takes
the space), a terminal labeled into a tab the document does not place is added to that tab's
right, and a workspace or tab the document does not list follows the ones it does, in hc's
terminal order. A tab the document does not know shows its terminals side by side.

Geometry comes from the tree alone: a tab is cut top down by the ratios, never from the
terminals' sizes. A viewer then sizes each terminal to its pane.

### Writing it

1. `doc.get ovis-layout`, and keep its `version`.
2. Reconcile it with the labels as above, and make the change.
3. `doc.set ovis-layout` with that `version`. On `conflict` someone wrote first: start again from
   step 1 (Ovis does so once, then reports the conflict).

A document whose `schema` is not one a client knows is neither read nor overwritten by it: Ovis
then lays tabs out from the labels and refuses layout changes.
