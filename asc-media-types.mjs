export const mediaDefinitions = {
  screenshot_set: {api:'v1',type:'appScreenshotSets',parent:'version_localization',relation:'appStoreVersionLocalization'},
  preview_set: {api:'v1',type:'appPreviewSets',parent:'version_localization',relation:'appStoreVersionLocalization'}
};
export const mediaTargets = {
  screenshot_set: {type:'appScreenshots',relation:'appScreenshotSet',mime:undefined},
  preview_set: {type:'appPreviews',relation:'appPreviewSet'}
};
export const maxPreviewBytes = 500 * 1024 * 1024;
export const maxScreenshotBytes = 20 * 1024 * 1024;
