import type { HomeScrollController } from "./home-scroll-controller"
import type { HomeSessionSearchController } from "./home-session-search-controller"
import type { HomeSessionsController } from "./home-sessions-controller"
import { HomeSessionsView } from "./home-sessions-view"

export function HomeSessions(props: {
  sessions: HomeSessionsController
  search: HomeSessionSearchController
  scroll: HomeScrollController
}) {
  return (
    <HomeSessionsView
      language={props.sessions.copy.language}
      groups={props.sessions.data.groups}
      showProjectName={props.sessions.session.showProjectName}
      server={props.sessions.session.server}
      canCreateSession={props.sessions.session.canCreate}
      searchValue={props.search.query.value}
      searchPlaceholder={props.search.query.placeholder}
      searchOpen={props.search.query.open}
      searchLoading={props.search.result.loading}
      searchError={props.search.result.error}
      searchSessions={props.search.result.sessions}
      searchMessages={props.search.result.messages}
      searchResults={props.search.result.list}
      searchActive={props.search.result.active}
      searchNoResultsLabel={props.search.result.noResultsLabel}
      titleOpacity={props.scroll.header.titleOpacity}
      isOpenTab={props.sessions.tab.isOpen}
      onCreateSession={props.sessions.session.create}
      onOpenSession={props.sessions.session.open}
      onArchiveSession={props.sessions.session.archive}
      onSetHoverTarget={props.scroll.viewport.setHoverTarget}
      onSetThumbTrack={props.scroll.viewport.setThumbTrack}
      onSetContent={props.scroll.header.setContent}
      onSetHeader={props.scroll.header.setHeader}
      onWheel={props.scroll.viewport.containWheel}
      onSetSearchRoot={props.search.element.setRoot}
      onSetSearchInput={props.search.element.setInput}
      onSetSearchList={props.search.element.setList}
      onSearchFocus={props.search.query.focus}
      onSearchInput={props.search.query.input}
      onSearchClose={props.search.query.close}
      onSearchMove={props.search.result.move}
      onSearchSelectActive={props.search.result.selectActive}
      onSearchHighlight={props.search.result.highlight}
      onSearchSelect={props.search.result.select}
      onCreateGroup={props.sessions.group.create}
      onAddToGroup={props.sessions.group.addSession}
      onRemoveFromGroup={props.sessions.group.removeFromAll}
      onRenameGroup={props.sessions.group.rename}
      onDeleteGroup={props.sessions.group.remove}
       onOpenGroupTab={props.sessions.group.openTab}
       onGroupSelected={props.sessions.group.groupSelected}
       selectedCount={props.sessions.selection.count}
       isSelected={props.sessions.selection.isSelected}
       onToggleSelection={props.sessions.selection.toggle}
       onClearSelection={props.sessions.selection.clear}
       onToggleGroupCollapsed={props.sessions.group.toggleCollapsed}
      isGroupCollapsed={props.sessions.group.isCollapsed}
      groupForSession={props.sessions.group.groupForSession}
      userGroups={props.sessions.group.userGroups}
      archivedRecords={props.sessions.archived.records}
      archivedCount={props.sessions.archived.count}
      archivedExpanded={props.sessions.archived.expanded}
      archivedLoading={props.sessions.archived.loading}
      archivedLoadingMore={props.sessions.archived.loadingMore}
      archivedError={props.sessions.archived.error}
      archivedHasMore={props.sessions.archived.hasMore}
      onToggleArchived={props.sessions.archived.toggle}
      onArchivedShowMore={props.sessions.archived.showMore}
      onUnarchiveSession={props.sessions.session.unarchive}
    />
  )
}
