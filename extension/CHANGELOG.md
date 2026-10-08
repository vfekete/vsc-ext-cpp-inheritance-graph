# Changelog

## 0.6.0

- Members are sorted by access (public, protected, private), constructors/destructors first, then alphabetically.
- Three checkboxes in every class title (`+` public, `#` protected, `-` private, with counts) show / hide that class's members of that access level; Alt+click applies to all classes. All visible by default. Static members are always shown.

## 0.5.0

- The attributes and methods sections of every class can be collapsed independently (▾/▸ at the section's top right; Alt+click applies to all classes). A collapsed section shows a one-line summary such as "5 methods".

## 0.4.0

- UML relationships beyond inheritance: realization, composition, aggregation, association and dependency, selectable in the *Relations* menu (setting `cppInheritanceGraph.relations`, default: inheritance only). Each kind has its own line style, marker and theme chart colour; labels show member, access and multiplicity; self relationships are drawn as loops.
- Selecting a class highlights its direct counterparts in all enabled relationships, with the connecting edges.
- Layout supports parallel and opposite edges between the same classes; edge labels are placed where edges fan out.
- Shorter toolbar option labels.

## 0.3.0

- Download the visible part of the graph as PNG (*⤓ PNG*; use *Fit* first for the whole graph). Text is at least 11 pt at 96 DPI; images over 16,384 px on a side require confirmation. Tiled rendering and a streaming PNG writer handle very large images.
- Edge labels (template arguments, access, virtual) are placed mid-edge so labels of edges sharing a class no longer overlap.

## 0.2.0

- Classes without inheritance relations are collected into collapsible groups (by namespace or folder); large groups start collapsed. New setting `cppInheritanceGraph.standaloneClasses` and toolbar menu *Standalone*.
- Unrelated hierarchies are laid out separately and packed into a compact block instead of one wide row.
- Packaging tool updated to @vscode/vsce 4 (no npm audit findings).

## 0.1.0

- Inheritance graph for a C++ file (editor / explorer context menu) or a folder (explorer context menu).
- Built-in preprocessor + parser, optional clang-uml backend, language-server fallback (go to definition, type hierarchy).
- Interactive SVG webview: parent highlighting, zoom / pan, search, navigation to classes, methods and fields, theme-aware colours.
