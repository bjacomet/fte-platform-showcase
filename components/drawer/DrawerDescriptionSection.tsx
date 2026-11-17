'use client'

import { memo } from 'react'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'
import ExternalRef from '@/components/ExternalRef'
import EditableTextField, { renderWithLinks } from '@/components/EditableTextField'

// Meta developer account is blocked — Marketing API access is suspended.
// Set to true to re-enable once a new Meta app is created and App Review is approved.
const FB_ADS_DISABLED = true

interface Props {
  creativeName: string
  onCreativeNameChange: (v: string) => void
  // Social card types carry two builds (social + the display set cut from it);
  // every other type has one build, and it goes in the Full Build field.
  isSocialBuild: boolean
  buildLink: string
  displayBuildLink: string
  onDisplayBuildLinkChange: (v: string) => void
  downloadingDisplayBuild: boolean
  downloadDisplayBuildError: string | null
  onDownloadDisplayBuild: () => void
  onBuildLinkChange: (v: string) => void
  downloadingBuild: boolean
  downloadBuildError: string | null
  onDownloadBuild: () => void
  showPublishButton: boolean
  publishingToFb: boolean
  publishFbError: string | null
  fbAdId: string | null
  fbCampaignId: string | null
  fbPublishedAt: string | null
  onPublishToFb: () => void
  canCopyForCopyTracker: boolean
  copyTrackerCopied: boolean
  onCopyForCopyTracker: () => void
  description: string
  onDescriptionChange: (v: string) => void
  // Read-only reflection of the carousel slides (empty for non-carousels). Rendered
  // beneath the editable Creative Brief; the user edits the slides below to change it.
  slideDetails?: string
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">{title}</span>
      <div className="flex-1 h-px bg-gray-700/60" />
    </div>
  )
}

export default memo(function DrawerDescriptionSection({
  creativeName, onCreativeNameChange, isSocialBuild,
  buildLink, onBuildLinkChange,
  displayBuildLink, onDisplayBuildLinkChange,
  downloadingDisplayBuild, downloadDisplayBuildError, onDownloadDisplayBuild,
  downloadingBuild, downloadBuildError, onDownloadBuild,
  showPublishButton, publishingToFb, publishFbError, fbAdId, fbCampaignId, fbPublishedAt, onPublishToFb,
  canCopyForCopyTracker, copyTrackerCopied, onCopyForCopyTracker,
  description, onDescriptionChange, slideDetails,
}: Props) {
  const lbl = drawerLabelClass
  const inp = drawerInputClass
  const ta  = `${inp} resize-none`

  return (
    <div>
      <SectionHeader title="Description" />
      <div className="space-y-3">
        <div>
          <label className={lbl}>Creative File Name</label>
          <input
            value={creativeName}
            onChange={(e) => onCreativeNameChange(e.target.value)}
            className={inp}
            placeholder="e.g. ClientName_300x250_v1"
          />
        </div>
        <div>
          <label className={lbl}>Link to Full Build {isSocialBuild && <span className="font-normal opacity-60">(social)</span>}</label>
          <input
            value={buildLink}
            onChange={(e) => onBuildLinkChange(e.target.value)}
            className={inp}
            placeholder="https://…"
          />
          {(buildLink || canCopyForCopyTracker) && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center gap-3 flex-wrap">
                {buildLink && (
                  <button
                    type="button"
                    onClick={onDownloadBuild}
                    disabled={downloadingBuild}
                    className="text-xs font-medium text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {downloadingBuild ? '⏳ Zipping…' : '⬇ Download Build'}
                  </button>
                )}
                {canCopyForCopyTracker && (
                  <button
                    type="button"
                    onClick={onCopyForCopyTracker}
                    title="Copy the creative name (linked to Adviewer), landing page, and end date — formatted for pasting into the Copy Tracker sheet"
                    className="text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    {copyTrackerCopied ? '✓ Copied for Copy Tracker!' : '⧉ Copy for Copy Tracker'}
                  </button>
                )}
                {buildLink && fbAdId ? (
                  <>
                    <span className="text-xs text-green-400 font-medium">
                      ✓ Published to FB Ads
                      {fbPublishedAt ? ` · ${new Date(fbPublishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                    </span>
                    {fbCampaignId && (
                      <a
                        href={`https://www.facebook.com/adsmanager/manage/campaigns?campaign_ids=${fbCampaignId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-[#1877F2] hover:text-blue-300 transition-colors"
                      >
                        Open in Ads Manager ↗
                      </a>
                    )}
                  </>
                ) : !FB_ADS_DISABLED && showPublishButton ? (
                  <button
                    type="button"
                    onClick={onPublishToFb}
                    disabled={publishingToFb}
                    className="text-xs font-medium text-[#1877F2] hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {publishingToFb ? '⏳ Publishing…' : '↑ Publish to Facebook Ads'}
                  </button>
                ) : null}
              </div>
              {downloadBuildError && (
                <p className="text-xs text-red-400">{downloadBuildError}</p>
              )}
              {publishFbError && (
                <p className="text-xs text-red-400">{publishFbError}</p>
              )}
            </div>
          )}
        </div>
        {/* The display set is cut from the approved social, so it belongs on the
            same card rather than a second one. Reference only: unlike the social
            build above it is not resolved to a box_folder_id, because that field
            is singular and drives both the file-sync webhook and the TTD export.
            See supabase/add_display_build_link.sql.
            Social cards only: on a Display/Video/Audio card the build IS the display
            set and belongs in Full Build above (that field wires the TTD sheet and
            Box sync). Still shown there if a link was already saved, so it can be moved. */}
        {(isSocialBuild || displayBuildLink.trim() !== '') && (
        <div>
          <label className={lbl}>Link to Display Build <span className="font-normal opacity-60">(HTML5 / sizes)</span></label>
          {!isSocialBuild && (
            <p className="text-[10px] text-amber-400 mb-1">This card&apos;s build belongs in Link to Full Build above — move the link there and clear this field.</p>
          )}
          <input
            value={displayBuildLink}
            onChange={(e) => onDisplayBuildLinkChange(e.target.value)}
            className={inp}
            placeholder="https://…"
          />
          {displayBuildLink.trim() && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={onDownloadDisplayBuild}
                  disabled={downloadingDisplayBuild}
                  className="text-xs font-medium text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {downloadingDisplayBuild ? '⏳ Zipping…' : '⬇ Download Display Build'}
                </button>
                <ExternalRef url={displayBuildLink} note="display build" />
              </div>
              {downloadDisplayBuildError && (
                <p className="text-xs text-red-400">{downloadDisplayBuildError}</p>
              )}
            </div>
          )}
        </div>
        )}
        {/* Carousel: the slides ARE the Creative Brief (read-only, live from the slides);
            the editable field becomes supplementary notes. Non-carousel: the editable field
            IS the Creative Brief and the slide bin is hidden. Card-type-aware per issue #80. */}
        {slideDetails ? (
          <div>
            <label className={lbl}>Creative Brief</label>
            <div
              className={`${ta} !cursor-default whitespace-pre-wrap break-words overflow-y-auto max-h-56`}
              aria-readonly="true"
            >
              {renderWithLinks(slideDetails)}
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              Auto-generated from the carousel slides below — read-only. Edit the slides to change it.
            </p>
          </div>
        ) : null}
        <div>
          <label className={lbl}>{slideDetails ? 'Additional Brief Notes' : 'Creative Brief'}</label>
          <EditableTextField
            value={description}
            onChange={onDescriptionChange}
            rows={3}
            className={ta}
            placeholder={slideDetails ? 'Any extra instructions or notes…' : 'Describe the creative request…'}
            linkify
          />
        </div>
      </div>
    </div>
  )
})
