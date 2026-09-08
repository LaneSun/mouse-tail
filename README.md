# Mouse Tail
A Gnome extension to draw the mouse tail on the screen

![screenshot.png](doc/screenshot.png)

## Styles

Settings are organized as a style: a set of defaults plus optional overrides
that apply only while the system uses a dark style.

- The preferences dialog shows a grid of preset styles; each preview renders
  the trail on light (top) and dark (bottom) backgrounds.
- **Customize…** opens the detailed editor: a Default/Dark toggle switches
  which state you are editing; in Dark mode each row has an icon-only revert
  button to drop the override and fall back to the default state.
- When your tweaks no longer match any listed style, a Custom card appears;
  pin it to keep it in the list. Pinned styles never change on their own —
  further edits create a new Custom card.
- Settings migrate automatically from older flat versions on first run.

## Development

```sh
./compile-schemas.sh                # compile the GSettings schema locally
node tests/test-style-engine.mjs    # unit tests for the shared style engine
gjs -m tests/integration-test.mjs    # integration test (schema + engine, in-memory dconf)
po/update-pot.sh                     # regenerate the translation template
po/compile-locales.sh                # compile po/*.po into locale/ (runtime translations)
./package.sh                         # build mouse-tail.zip for extensions.gnome.org
```