# Base-Style Enterprise Web Application Layout Specification

## 1. Purpose

This document defines the global web application layout inspired by the supplied  Base-Style screenshot.

The goal is to reproduce the overall structure, sizing behavior, visual hierarchy, and interaction rules of a dark enterprise management system.

The layout must be reusable across application pages. Individual pages should provide their own content without independently reimplementing the topbar, sidebar, or viewport sizing behavior.

### Core principles

1. The application occupies the available browser viewport.
2. The topbar remains at the top.
3. The sidebar remains on the left below the topbar.
4. The main content occupies the remaining space.
5. The page must not develop unintended horizontal or vertical overflow.
6. The main content must support data-heavy pages with tables, filters, forms, and dashboards.
7. Resizing the browser must recalculate available space without breaking the layout.
8. Shared layout components must behave consistently across all routes.
9. The visual style is a compact, dark enterprise admin interface.
10. Layout dimensions should be controlled by CSS and available viewport space, not by individual page content.

---

## 2. Overall Application Structure

The application consists of four primary regions:

```text
ApplicationShell
├── Topbar
└── Workspace
    ├── Sidebar
    └── MainContent
        ├── PageHeader / PageToolbar
        ├── Optional InformationBanner
        └── PageContent
```

### Region responsibilities

- **ApplicationShell:** controls viewport dimensions and prevents unintended document-level overflow.
- **Topbar:** global branding, global search, and user identity.
- **Workspace:** fills the space below the topbar.
- **Sidebar:** primary navigation grouped by functional domain.
- **MainContent:** displays the currently selected route.
- **PageHeader:** page title, record count, description, and page-level actions.
- **InformationBanner:** optional notices such as read-only/demo mode.
- **PageContent:** route-specific content, including tables, forms, cards, dashboards, and detail views.

The shell and workspace must be shared across routes. Navigating from Customers to Orders should replace the page content without rebuilding or repositioning the global layout.

---

## 3. Viewport and Sizing Rules

### Application shell

- Occupies the full dynamic viewport height.
- Uses a vertical flex layout.
- Prevents the document from growing indefinitely because of wide or tall page content.
- Accounts for browser viewport changes.
- Prefer `height: 100dvh` with appropriate fallbacks if required by the project's browser support policy.

### Topbar

- Has a stable height.
- Does not shrink when main content becomes larger.
- Remains at the top of the application.
- Does not scroll vertically with the page content.

### Workspace

- Fills all remaining height below the topbar.
- Uses a horizontal flex layout.
- Has `min-height: 0` so child content can scroll within its allocated area.
- Prevents child elements from forcing the entire workspace beyond the viewport.

### Sidebar

- Has a stable expanded width controlled by a design token or CSS variable.
- Does not shrink automatically because main content becomes narrow.
- Uses its own scrolling region if navigation items exceed available height.
- Does not create document-level horizontal scrolling.

### Main content

- Occupies the remaining width after accounting for the sidebar.
- Uses `flex: 1` or an equivalent grid definition.
- Must have `min-width: 0` and `min-height: 0`.
- Uses a vertical layout to arrange banners, headers, toolbars, and page content.
- Allows route-specific components to manage their own internal scrolling.

Do not use arbitrary fixed pixel offsets to position the main content relative to the sidebar. Use flexbox or CSS Grid.

---

## 4. Topbar Specification

### 4.1 Structure

```text
Topbar
├── BrandArea
│   ├── ProductLogo
│   ├── ProductName
│   └── VersionBadge
├── GlobalSearch
└── UserArea
    ├── Avatar
    ├── DisplayName
    └── Role
```

### 4.2 Brand area

- Aligned to the left.
- Logo/icon appears before the product name.
- Product name is visually prominent.
- Version badge is compact and placed beside the product name.
- Elements are vertically centered.
- Maintain consistent spacing between logo, title, and version.

### 4.3 Global search

- Located between the brand area and user area.
- Contains a search icon, input, and optional dropdown indicator.
- Has a dark input background with a subtle border.
- Uses muted placeholder text.
- Occupies available space only up to a defined maximum width.
- Must not overlap the brand or user area when the viewport becomes narrow.

The exact search behavior is a product concern. The layout only defines its position, sizing, and visual appearance.

### 4.4 User area

- Aligned to the right.
- Contains a circular avatar with initials or a profile image.
- Displays the user's name and role.
- Name uses primary text styling; role uses smaller secondary text.
- All elements are vertically centered.
- The user area should not be compressed to the point that its contents overlap.

### 4.5 Topbar visual rules

- Dark navy background, slightly lighter than the page background.
- Thin bottom border separating it from the workspace.
- Compact horizontal padding.
- Consistent vertical alignment.
- Stable height across routes.
- High-contrast product name and restrained secondary text.

---

## 5. Sidebar Specification

### 5.1 Structure

```text
Sidebar
├── NavigationArea
│   ├── NavigationGroup
│   │   ├── GroupTitle
│   │   └── NavigationItem[]
│   └── NavigationGroup[]
└── SidebarBottomArea
    └── CollapseButton
```

### 5.2 Navigation groups

The reference screenshot uses grouped navigation such as:

- Sales & Customers
- Order Operations
- Design Management
- Manufacturing & Production

These are example categories from the reference. Use the actual application's route structure and labels.

### 5.3 Group title

- Small uppercase text.
- Muted gray-blue color.
- Medium or semibold font weight.
- Consistent spacing above and below each group.
- Not styled as a primary clickable item unless the application explicitly supports collapsible groups.

### 5.4 Navigation item

Each item contains:

```text
NavigationItem
├── Icon
└── Label
```

Rules:

- Icon appears to the left of the label.
- Items have consistent height, horizontal padding, and border radius.
- Labels are aligned consistently.
- Icons use a consistent size and visual style.
- Inactive items use muted text and icon colors.
- Hover state provides subtle feedback.
- Active route uses a bright cyan/blue background, stronger text contrast, and a clearly visible active state.
- Active styling must follow the current route, not a manually maintained visual flag.
- Long labels should not overlap adjacent elements.

### 5.5 Navigation behavior

- Clicking a navigation item changes the route or activates the corresponding view.
- The active navigation item updates according to the current route.
- Browser refresh on a nested route must preserve the correct active item if routing is configured to support direct access.
- Browser back/forward navigation must update the active state.
- Do not reload the entire application unnecessarily when using client-side routing.
- Navigation groups and items should use the project's existing router and route definitions.

### 5.6 Sidebar collapse behavior

The reference includes a collapse control near the bottom of the sidebar.

When expanded:

- Display icons and labels.
- Use the expanded sidebar width.
- Group titles are visible.

When collapsed:

- Reduce the sidebar to a narrower width.
- Keep navigation icons visible.
- Hide or visually suppress labels and group headings.
- Preserve navigation functionality.
- Provide tooltips or accessible labels for icon-only navigation.
- Update the main content width automatically.
- Avoid horizontal overflow when toggling states.

The collapse button stays in the bottom area, visually separated from the navigation list.

Persisting the collapsed state across page reloads is optional and should follow the existing application conventions.

### 5.7 Sidebar scrolling

- Sidebar navigation scrolls independently if it exceeds available height.
- The bottom collapse area remains accessible.
- Use a flex column layout with a scrollable navigation region and a non-shrinking bottom region.
- Avoid placing the collapse control inside the same scrolling list if doing so causes it to disappear.

---

## 6. Main Content Specification

### 6.1 Content area

The main content region occupies the remaining space to the right of the sidebar.

It should use a vertical flex layout:

```text
MainContent
├── PageHeader
├── OptionalBanner
├── PageToolbar
└── PageBody
```

The actual order may vary by page when the design requires it, but shared patterns should remain consistent.

Rules:

- Horizontal padding is consistent across routes.
- Top padding separates content from the topbar.
- Page content must not overlap the sidebar.
- `min-width: 0` and `min-height: 0` are required where flex children contain wide tables or scrollable content.
- Do not apply a global minimum width that forces the entire application to overflow horizontally.
- Avoid adding unnecessary nested scroll containers.

### 6.2 Page header

The page header provides context for the current route.

Typical structure:

```text
PageHeader
├── TitleRow
│   ├── PageTitle
│   ├── OptionalCountBadge
│   └── PageActions
└── Description
```

Rules:

- Title is left-aligned and visually prominent.
- An optional count badge appears beside the title.
- Page-level actions such as refresh align to the right of the title row.
- Description appears below the title row in muted text.
- The header should not stretch vertically based on unrelated table data.
- On narrower screens, actions may wrap or move to another row without overlapping the title.

### 6.3 Information banner

When present:

- Appears above the main page content or in the defined location for that route.
- Uses a subtle border and background.
- Contains an icon followed by a concise message.
- Uses a distinct but restrained accent color.
- Does not behave like a modal or block interaction with the entire page unless explicitly required.
- Does not cause table controls to overlap it when the viewport changes.

For a read-only demo, the banner must clearly communicate that data-changing actions are disabled.

### 6.4 Page body

The page body occupies the remaining vertical space after headers, banners, and toolbars.

For data-heavy pages:

- Use `flex: 1`, `min-height: 0`, and an appropriate overflow strategy.
- Tables should manage their own vertical/horizontal scrolling.
- Footers and pagination should remain in their defined component regions.
- A page with a table must not force the entire application to become taller than the viewport.
- A dashboard page may use its own internal scroll behavior if its content genuinely exceeds the available height.

---

## 7. Spacing and Alignment

Use a consistent spacing system instead of arbitrary values in each route.

Suggested design tokens:

```css
:root {
  --topbar-height: 72px;
  --sidebar-width: 290px;
  --sidebar-collapsed-width: 76px;

  --page-padding-x: 32px;
  --page-padding-top: 30px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
}
```

These values are initial estimates based on the supplied screenshot, not exact measurements. Inspect the existing application and tune them against the reference before finalizing.

Rules:

- Use the same horizontal alignment for page title, description, toolbar, and content panel.
- Maintain consistent gaps between navigation groups.
- Keep controls vertically centered within their rows.
- Use compact enterprise spacing; avoid excessive padding.
- Prefer shared tokens over duplicated magic numbers.
- Responsive adjustments may change page padding and sidebar dimensions when necessary.

---

## 8. Color and Typography

### 8.1 Color hierarchy

Use the existing theme system when available. Otherwise, approximate the reference with these roles:

- **Application background:** very dark navy or near-black.
- **Topbar/sidebar:** lighter navy surface.
- **Panel background:** dark navy/charcoal.
- **Border:** subtle blue-gray.
- **Primary text:** near-white.
- **Secondary text:** muted gray-blue.
- **Accent:** bright cyan/blue.
- **Active navigation:** accent background with readable foreground.
- **Interactive values:** accent text when interaction is real.
- **Disabled controls:** subdued but still legible.

Avoid excessive bright borders, gradients, and shadows. The interface should feel like a dense enterprise management system.

### 8.2 Typography

- Use one consistent application font stack.
- Product name and page title use stronger weight.
- Sidebar group headings use compact uppercase typography.
- Main body text is readable but visually restrained.
- Secondary labels are smaller and muted.
- Input placeholders are less prominent than entered values.
- Maintain consistent line heights and font weights across routes.

Do not introduce a new font dependency if the project already defines a suitable font system.

---

## 9. Responsive behavior

The screenshot represents a desktop admin interface. Preserve that layout as long as there is enough horizontal space.

### Wide desktop

- Full topbar.
- Expanded sidebar.
- Main content uses the remaining width.
- Tables may overflow horizontally within their own containers.

### Narrow desktop or reduced browser width

- Keep the topbar elements from overlapping.
- Collapse the sidebar automatically only if this behavior is explicitly part of the product design; otherwise use the manual collapse control.
- Reduce page padding when appropriate.
- Allow page-header actions to wrap.
- Keep the table's horizontal scrolling inside the table region.
- Never let a wide table push the sidebar off-screen or create application-wide horizontal scrolling.

### Short viewport height

- Topbar and sidebar structure remain intact.
- Main content uses the remaining height.
- Scrollable areas become shorter rather than pushing the footer beyond the viewport.
- Sidebar navigation may scroll independently.

### Zoom and resize

- Recalculate layout using CSS flex/grid rather than fixed offsets.
- Keep the topbar, sidebar, main content, and table regions within their assigned boundaries.
- Avoid hard-coded absolute positioning for primary layout regions.
- Test multiple viewport sizes and browser zoom levels.

Mobile-specific transformation into a drawer or bottom navigation is outside the current screenshot reference. Do not implement it unless required by the project.

---

## 10. Overflow and Scroll Ownership

Every scrollable region must have a clearly defined owner.

| Region | Expected behavior |
|---|---|
| Application shell | No unintended document-level overflow |
| Topbar | Does not scroll with main content |
| Sidebar navigation | Scrolls independently when its items exceed available height |
| Main content | Uses available space; does not expand indefinitely |
| Table body | Owns vertical scrolling for table rows |
| Table horizontal scrollbar | Remains at the bottom of the table panel above the footer |
| Table footer | Remains pinned to the bottom of the table panel |
| Dashboard page body | May scroll internally if its content exceeds the available height |

Avoid nested scrollbars unless there is a clear reason. Do not apply `overflow: hidden` to an ancestor if it clips a required menu, tooltip, focus ring, or scrollbar.

Use `min-height: 0` on flex children that need to shrink and scroll. Use `min-width: 0` on flex children containing wide content.

---

## 11. Suggested CSS Layout Skeleton

This is a starting point. Adapt it to the current framework and component hierarchy.

```css
.app-shell {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--app-background);
}

.app-topbar {
  height: var(--topbar-height);
  flex: 0 0 var(--topbar-height);
  display: flex;
  align-items: center;
  min-width: 0;
}

.app-workspace {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.app-sidebar {
  flex: 0 0 var(--sidebar-width);
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-sidebar.is-collapsed {
  flex-basis: var(--sidebar-collapsed-width);
}

.sidebar-navigation {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.sidebar-bottom {
  flex: 0 0 auto;
}

.app-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.page-content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--page-padding-top) var(--page-padding-x);
  overflow: hidden;
}
```

Important:

- The CSS skeleton does not implement routing, menus, or table scrolling by itself.
- The actual table component must implement the separate persistent horizontal scrollbar requirement described in the table specification.
- Verify the DOM hierarchy before applying sticky positioning or overflow.
- If existing layout components already implement these rules, extend them instead of duplicating them.

---

## 12. Reusability and Routing

- Build the shell from reusable components such as `AppLayout`, `AppTopbar`, `AppSidebar`, and `PageLayout`.
- Use the existing routing library and route configuration.
- Navigation labels, icons, and paths should come from a consistent navigation configuration where practical.
- Active menu state must be derived from the current route.
- Page-specific content should be rendered through the router's layout/child route mechanism.
- Avoid duplicating the global shell on every page.
- Keep layout state such as sidebar collapse in one authoritative place.
- Preserve existing authentication and authorization behavior; the layout must not bypass route protection.
- Do not add a new state-management dependency solely to handle the sidebar if local state or existing application state is sufficient.

---

## 13. Accessibility

- Use semantic navigation elements for the sidebar.
- Use buttons for interactive controls and links for navigation.
- Icon-only buttons need accessible labels or tooltips.
- The active navigation item should be identifiable beyond color alone.
- Preserve keyboard focus visibility.
- Menus and dropdowns must be keyboard-accessible.
- Ensure sufficient contrast for muted text and disabled controls.
- Do not make non-interactive labels appear clickable.
- Ensure collapse state is communicated to assistive technology where appropriate.

---

## 14. Acceptance Criteria

- [ ] The app shell fills the available viewport height.
- [ ] Topbar stays at the top and does not shrink unexpectedly.
- [ ] Sidebar stays on the left below the topbar.
- [ ] Sidebar navigation scrolls independently if necessary.
- [ ] Sidebar collapse/expand updates main-content width without layout breakage.
- [ ] Main content occupies the remaining width and height.
- [ ] Navigating between routes preserves the global shell.
- [ ] Active navigation follows the current route, including browser back/forward navigation.
- [ ] Page headers and actions align consistently.
- [ ] Wide tables do not cause application-wide horizontal overflow.
- [ ] Table body scrolls internally when required.
- [ ] Table panel height does not depend on the number of rows.
- [ ] Persistent horizontal scrollbar remains above the table footer.
- [ ] Table footer remains at the bottom of its panel.
- [ ] Resizing or zooming does not overlap topbar, sidebar, and main content.
- [ ] Short viewports do not push key controls outside their allocated regions.
- [ ] Dark theme styling is consistent across routes.
- [ ] Existing authentication and authorization behavior remains intact.

---

## 15. Instructions to Claude Code

Before implementing:

1. Inspect the existing project structure, router, global layout, theme tokens, and shared components.
2. Identify the existing layout entry point and route nesting.
3. Compare the current implementation with this specification and the supplied  Base-Styles screenshot.
4. List the gaps before making changes.
5. Reuse existing components and conventions wherever practical.
6. Do not replace the routing or styling architecture unless a concrete technical issue requires it.

During implementation:

1. Implement the application shell and its sizing rules first.
2. Implement topbar and sidebar alignment and collapse behavior.
3. Ensure route content is rendered inside the shared main-content area.
4. Verify scroll ownership and overflow boundaries.
5. Integrate the existing table specification for fixed-height data grids and persistent horizontal scrollbars.
6. Preserve existing business logic, permissions, and route protection.
7. Avoid unrelated refactoring.

After implementation:

1. Run available lint, typecheck, and tests.
2. Test direct navigation to nested routes and browser back/forward behavior.
3. Test sidebar collapse/expand.
4. Test wide and narrow viewports, short viewport heights, and browser zoom.
5. Test a wide table and confirm that only its intended region scrolls horizontally.
6. Report modified files, checks performed, results, and remaining limitations.

Do not claim visual parity or successful testing unless it has actually been verified against the reference.
