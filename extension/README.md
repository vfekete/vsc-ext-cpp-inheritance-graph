# C++ Inheritance Graph

Source code and issues: <https://github.com/vfekete/vsc-ext-cpp-inheritance-graph>

A VS Code extension that draws an interactive, theme-aware UML-style inheritance graph for the
C++ classes defined in a header file or in every header of a folder. Starting from those classes it
walks the base classes upwards until it reaches the root, a standard-library / builtin type, or a
type defined outside the configured scope.

## Usage

| Where | How |
|---|---|
| Current file | Right-click in a C++ editor → **Show C++ Inheritance Graph for File**, the graph icon in the editor title bar, or the command palette |
| A header in the Explorer | Right-click the file → **Show C++ Inheritance Graph for File** |
| A folder | Right-click the folder in the Explorer → **Show C++ Inheritance Graph for Folder** (all headers, recursively by default) |

In the graph:

- **Click** a class to select it. Its edges to its **direct parents**, and the parents themselves, are highlighted, and everything else is dimmed. The *Highlight* menu can extend this to all ancestors, or to ancestors plus descendants.
- **Double-click**, or **Ctrl/Cmd+click**, to jump to a declaration. The target depends on where you click: the class title opens the class, and a method or field row opens that member. With `cppInheritanceGraph.navigateOn: "click"`, a single click navigates.
- **Drag** to pan. Use the **mouse wheel** or a pinch to zoom around the cursor.
- **Keys:** `F` fits the graph, `+`/`-` zoom, `0` resets to 100 %, the arrow keys pan, `C` centres the selection, `Enter` opens the selection, `/` searches, and `Esc` clears.
- Use the toolbar to switch between *bases on top* and *bases on left*, to show all members, public members only, or none, and to search for a class. The ▾ in a class header hides all of that class's members. Each **attributes** and **methods** section has its own ▾/▸ at its top right, which collapses that section to a one-line summary such as "5 methods". Click the summary to expand it again, or **Alt+click** to collapse or expand that section in every class.
- **Relations ▾** shows other UML relationships besides inheritance. Each kind has its own line style and theme colour, and only *Inheritance* is selected by default:

  | Kind | Derived from | Drawn as | Theme colour |
  |---|---|---|---|
  | Inheritance (generalization) | base classes | solid line, hollow triangle | neutral |
  | Realization | base class is an interface: all methods pure virtual, no data members | dashed line, hollow triangle | `charts.purple` |
  | Composition | member by value, `unique_ptr`, `optional`, `array`, containers of values | filled diamond at the owner | `charts.red` |
  | Aggregation | `shared_ptr`, containers of (shared) pointers | hollow diamond at the owner | `charts.yellow` |
  | Association | raw pointer or reference member, `weak_ptr`, `span` | open arrow | `charts.green` |
  | Dependency | class used only in method parameters or return types | dashed line, open arrow | `charts.blue` |

  - Edge labels show the member with its access (`+`/`#`/`-`) and the multiplicity (`1`, `0..1`, `*`). A class's relationships with itself, such as `Node* m_parent`, are drawn as loops.
  - When a class is selected, its direct counterparts in every enabled relationship, in both directions, are highlighted together with the connecting edges in that relationship's colour. Inheritance highlighting works as before.
  - Classes reachable only through such a relationship are added to the graph, but they appear only while that kind is enabled, and their own base classes are not followed.
- **Members** are listed by access: public, then protected, then private. Within each access level, constructors and destructors come first, and the rest is sorted alphabetically.
- **Access checkboxes:** each class title has three checkboxes with member counts: `+` public, `#` protected, `-` private. Unchecking one hides that class's members of that access level, and **Alt+click** does the same in every class. All three are checked by default. **Static members are always shown**, whatever the checkboxes or the *Members: Public* menu say.
- **Standalone classes** are classes with no inheritance relation in the graph, such as plain data structs. They are collected into collapsible **groups**, by namespace or by folder, placed under the hierarchies. Groups with more than 8 classes start collapsed and show only a name preview, so even thousands of them don't push the inheritance structure out of view. Click a group to expand or collapse it, or **Alt+click** to toggle all groups. Search finds classes inside collapsed groups and opens the group. The *Standalone* menu can also show them as a packed grid, or hide them.
- **⤓ PNG** saves the visible part of the graph as a PNG image, exactly as shown. To save the whole graph, press **Fit** first.
  - The image is scaled so that its smallest text is at least **11 pt** at 96 DPI, and that DPI is stored in the file. It is never smaller than what's on screen.
  - If a side would exceed **16,384 px**, you're warned first and can still choose *Export Anyway*.
  - Rendering is done in tiles and written as a stream, so very large images don't need to fit in memory. Progress is shown and the export can be cancelled.
- Unrelated hierarchies are laid out separately and packed into a compact block, rather than spread along one wide row.
- **Seed classes** (defined in the selected file or folder) have an accent border. External, unresolved, or out-of-scope types have a dashed border and are not expanded further. Virtual inheritance edges are dashed. Template arguments and non-public access appear on the edge.

All colours come from the active theme's tokens (editor, widget, focus border, symbol icon and
chart colours). Light, dark and high-contrast themes all stay readable.

## How the inheritance information is gathered

The extension combines three sources:

1. **Built-in parser.** This source is always available. A small C preprocessor runs on the header and everything it includes. It supports `#include` resolution, object and function-like macros (`#`, `##`, `__VA_ARGS__`), `#if`/`#ifdef` evaluation and `__has_include`. A declaration-level C++ parser then extracts classes, bases and members. Because macros are expanded, classes declared through macros (`DECLARE_COMPONENT(Foo, Bar) {...}`) and computed includes (`#include CORE_HEADER(object)`) are handled.
2. **clang-uml.** This source is optional and used automatically when it is on `PATH`. The extension builds a synthetic translation unit for the selected headers, runs clang-uml's JSON class-diagram generator, and merges the compiler-accurate bases into the graph.
3. **The active C++ language server.** This could be Microsoft C/C++ IntelliSense, clangd, or another server. If a base class still can't be resolved, the extension asks the server for *Go to Definition* at the base-class name and parses the file it points to. If the server implements *type hierarchy* (clangd does), the reported supertypes are merged in as well. This catches includes hidden behind build-system macros that only the real compile configuration knows about.

Include paths and defines are read from:

- `.vscode/c_cpp_properties.json`
- `C_Cpp.default.*`
- `compile_commands.json`: the workspace root, `build*/`, `out/` and `cmake-build-*/` are searched, or you can set `cppInheritanceGraph.compileCommands`
- the extension's own `includePaths` and `defines` settings

If an include still cannot be found, a header with a matching path suffix anywhere in the workspace is used (`fuzzyIncludeResolution`).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cppInheritanceGraph.traversalScope` | `workspace` | Which base classes get expanded. `workspace` expands classes defined in the workspace folders. `includePaths` also expands classes from any non-system include dir. `targetDirectory` expands only classes inside the selected folder, or the selected file's folder. Bases outside the scope are shown, but their own bases are not followed. |
| `cppInheritanceGraph.additionalScopeRoots` | `[]` | Extra directories treated like the workspace. |
| `cppInheritanceGraph.externalNamespaces` | `std`, `boost`, `__gnu_cxx`, `Qt` | Types in these namespaces are always leaves. |
| `cppInheritanceGraph.includePaths` / `defines` | `[]` | Additional include dirs (`${workspaceFolder}` and trailing `/**` supported) and defines. |
| `cppInheritanceGraph.compileCommands` | `""` | Path to `compile_commands.json` or its folder. |
| `cppInheritanceGraph.folder.recursive` | `true` | Folder mode includes sub-folders. |
| `cppInheritanceGraph.headerExtensions` | `.h .hh .hpp .hxx …` | What counts as a header in folder mode. |
| `cppInheritanceGraph.clangUml.mode` | `auto` | `auto`, `always` or `never`. |
| `cppInheritanceGraph.clangUml.path` / `extraArgs` / `timeoutMs` | | clang-uml executable and flags. |
| `cppInheritanceGraph.cppStandard` | `""` | `-std` for clang-uml. By default it is taken from the project config, falling back to `c++17`. |
| `cppInheritanceGraph.languageServer.enabled` / `timeoutMs` | `true` / `4000` | Use the language server as a fallback. |
| `cppInheritanceGraph.navigateOn` | `doubleClick` | `doubleClick` or `click`. |
| `cppInheritanceGraph.showMembers` | `all` | Initial member visibility: `all`, `public` or `none`. |
| `cppInheritanceGraph.relations` | `["inheritance"]` | Relationships shown when a graph opens: any of `inheritance`, `realization`, `composition`, `aggregation`, `association`, `dependency`. You can change them in the graph's *Relations* menu. |
| `cppInheritanceGraph.standaloneClasses` | `namespace` | How classes without inheritance relations are shown: grouped by `namespace` or `folder`, as an `inline` grid, or `hidden`. |
| `cppInheritanceGraph.layoutDirection` | `TB` | `TB` puts bases on top. `LR` puts bases on the left. |
| `cppInheritanceGraph.maxDepth` | `64` | Maximum number of inheritance levels to follow. |

Analysis details go to the **C++ Inheritance Graph** output channel: include sources, parsed files, which backend resolved what, and unresolved includes. Notes also appear behind the ⚠ button in the graph's status bar.

## Build and deploy from the command line

Requirements: Node.js 22 or newer (needed by the packaging tool `@vscode/vsce` 4), and the `code` CLI on `PATH`. Run these from the `extension/` directory:

```bash
scripts/deploy.sh                 # npm ci, compile, test, package dist/*.vsix, code --install-extension
scripts/deploy.sh --no-install    # only build dist/cpp-inheritance-graph-<version>.vsix (also copied to ../deployment/)
scripts/deploy.sh --code codium   # install into another VS Code flavour
scripts/deploy.sh --copy          # copy into ~/.vscode/extensions without vsce
```

If you'd rather run the steps by hand (also from `extension/`):

```bash
npm ci
npm run package                              # -> dist/cpp-inheritance-graph-<version>.vsix
code --install-extension dist/cpp-inheritance-graph-<version>.vsix --force
```

After installing, reload the VS Code window.

## Development

```bash
cd extension
npm install
npm run compile        # or: npm run watch
npm test               # unit tests (node:test): parser, preprocessor, graph, layout, extension smoke test
```

To run the extension from source, open the repository root (the parent of `extension/`) in VS Code and press F5. That launches the *Run Extension* configuration, which opens the mock project in `../test/mock/`.

There's also a command-line front end for the analysis that doesn't need VS Code (run from `extension/`):

```bash
node out/src/cli.js ../test/mock/include/scene/mesh_instance.h
node out/src/cli.js ../test/mock/include --clang-uml always
node out/src/cli.js ../test/mock/include/render --scope targetDirectory
node out/src/cli.js ../test/mock/edge-cases/edge_cases.h -D 'PLUGIN_SDK_HEADER="sdk/plugin_base.h"' --json
```

### Test workspace

`../test/mock/` (repository `test/mock/`) is a mock C++17 "engine" that compiles (`clang++ -fsyntax-only -Iinclude -Ithird_party/acme/include src/main.cpp`). It exercises the following cases:

- A nine-level hierarchy: `AnimatedCharacterMesh → SkinnedMeshInstance → MeshInstance → GeometryInstance → VisualInstance → Spatial → Node → RefCounted → Object`.
- Multiple inheritance, CRTP (`Observable<Node>`), interfaces, and mixins.
- A virtual-inheritance diamond (`ui::Control`).
- Template bases with arguments (`ValueControl<float>`) and a template-parameter base (`core::Named<Base>`).
- Bases from the standard library (`std::runtime_error`) and from a third-party include dir (`acme::LinearAllocator`).
- `include/scene/scene_tree.h`, which shows every UML relationship: an interface, `unique_ptr`/`optional`/value members, `shared_ptr` containers, `weak_ptr` and raw pointers, and types used only in method signatures.
- A header with ~50 plain data structs in four namespaces (`include/data/records.h`) for standalone grouping.
- Includes computed through macros (`#include CORE_HEADER(refcounted)`, `#include RENDER_BACKEND_HEADER`), inheritance hidden in a macro (`DECLARE_COMPONENT`), and `#if`-guarded classes.

`../test/mock/edge-cases/` is parser torture that isn't part of the compiled project. It covers aliases, namespace aliases, export and attribute macros, `#if 0`, explicit specializations, nested classes, C-style `typedef struct`, operators, function pointers, bit-fields, and a base that can only be resolved with `-DPLUGIN_SDK_HEADER=...` or a language server.

## Limitations

- Relationship kinds are inferred from declarations, much like clang-uml's defaults. Usage inside function bodies isn't analysed, and the ownership semantics of user-defined smart pointers can't be known: a project template such as `Ref<T>` is treated as composition of `Ref` plus an association to `T`.
- The built-in parser is heuristic. It doesn't instantiate templates or evaluate `decltype` bases, and it can't see includes that depend on defines it doesn't know about. Enable clang-uml or a language server for exact results on complex code bases.
- Microsoft C/C++ IntelliSense doesn't implement the type-hierarchy API, so only its *Go to Definition* is used. With clangd, supertypes are queried too.
- Derived classes are only shown when they are defined in the selected file or folder. The graph follows bases upwards, not subclasses downwards.

## License

Copyright (c) 2026 Vladimir Fekete. Released under the MIT License (see the LICENSE file).

Co-authored: Claude
