import Api from './api/api.js';
import ApiUtils from './api/api-utils.js';
import { timeToHHMMSS, isPatternValid } from './utils/helpers.js';
import log from './ui/logic/log.js';
import { apiSettingsDefault } from './api/api-utils-deafault-presets.js';

export default class Core {
  constructor() {
    this.isProcessRunning = false;
    this.api = new Api();
  }

  async getAndFilterMedia(filter, source) {
    let mediaItems = [];
    if (source === 'library') {
      log('Reading library');
      if (filter.dateType === 'uploaded') mediaItems = await this.getLibraryItemsByUploadDate(filter);
      else if (filter.dateType === 'taken') mediaItems = await this.getLibraryItemsByTakenDate(filter);
    } else if (source === 'search') {
      log('Reading search results');
      mediaItems = await this.apiUtils.getAllSearchItems(filter.searchQuery);
    } else if (source === 'trash') {
      log('Getting trash items');
      mediaItems = await this.apiUtils.getAllTrashItems();
    } else if (source === 'lockedFolder') {
      log('Getting locked folder items');
      mediaItems = await this.apiUtils.getAllLockedFolderItems();
    } else if (source === 'favorites') {
      log('Getting favorite items');
      mediaItems = await this.apiUtils.getAllFavoriteItems();
    } else if (source === 'sharedLinks') {
      log('Getting shared links');
      const sharedLinks = await this.apiUtils.getAllSharedLinks();
      if (!sharedLinks) {
        log('No shared links found', 'error');
        return;
      }
      log(`Shared Links Found: ${sharedLinks.length}`);
      for (const sharedLink of sharedLinks) {
        log('Getting shared link items');
        const sharedLinkItems = await this.apiUtils.getAllMediaInSharedLink(sharedLink.linkId);
        mediaItems.push(...sharedLinkItems);
      }
    } else if (source === 'albums') {
      if (!filter.albumsInclude) {
        log('No target album!', 'error');
        throw new Error('no target album!');
      }
      filter.albumsInclude = Array.isArray(filter.albumsInclude) ? filter.albumsInclude : [filter.albumsInclude];
      for (const albumMediaKey of filter.albumsInclude) {
        log('Getting album items');
        mediaItems.push(...(await this.apiUtils.getAllMediaInAlbum(albumMediaKey)));
      }
    }

    log('Source read complete');
    log(`Found items: ${mediaItems?.length}`);

    if (!this.isProcessRunning) return;

    if (mediaItems?.length && (filter.lowerBoundaryDate || filter.higherBoundaryDate) && source !== 'library') {
      // library has its own date filter
      mediaItems = this.filterByDate(mediaItems, filter);
    }

    if (mediaItems?.length && filter.albumsExclude) {
      const itemsToExclude = [];
      filter.albumsExclude = Array.isArray(filter.albumsExclude) ? filter.albumsExclude : [filter.albumsExclude];

      for (const albumMediaKey of filter.albumsExclude) {
        log('Getting album items to exclude');
        itemsToExclude.push(...(await this.apiUtils.getAllMediaInAlbum(albumMediaKey)));
      }
      log('Excluding album items');
      mediaItems = mediaItems.filter((mediaItem) => {
        return !itemsToExclude.some((excludeItem) => excludeItem.dedupKey === mediaItem.dedupKey);
      });
    }
    if (mediaItems?.length && filter.excludeShared) {
      log('Getting shared links\' items to exclude');
      const itemsToExclude = [];
      const sharedLinks = await this.apiUtils.getAllSharedLinks();
      for (const sharedLink of sharedLinks) {
        const sharedLinkItems = await this.apiUtils.getAllMediaInSharedLink(sharedLink.linkId);
        itemsToExclude.push(...sharedLinkItems);
      }
      log('Excluding shared items');
      mediaItems = mediaItems.filter((mediaItem) => {
        return !itemsToExclude.some((excludeItem) => excludeItem.dedupKey === mediaItem.dedupKey);
      });
    }
    if (mediaItems?.length && filter.owned) mediaItems = this.filterOwned(mediaItems, filter);
    if (mediaItems?.length && filter.uploadStatus) mediaItems = this.filterByUploadStatus(mediaItems, filter);
    if (mediaItems?.length && filter.archived) mediaItems = this.filterArchived(mediaItems, filter);
    if ((mediaItems?.length && filter.favorite) || filter.excludeFavorites) mediaItems = this.filterFavorite(mediaItems, filter);
    if (mediaItems?.length && filter.type) mediaItems = this.filterByMediaType(mediaItems, filter);

    if (
      mediaItems?.length &&
      (filter.space || filter.quality || filter.lowerBoundarySize || filter.higherBoundarySize || filter.fileNameRegex || filter.descriptionRegex)
    ) {
      mediaItems = await this.extendMediaItemsWithMediaInfo(mediaItems);
      if (mediaItems?.length && filter.fileNameRegex) mediaItems = this.fileNameFilter(mediaItems, filter);
      if (mediaItems?.length && filter.descriptionRegex) mediaItems = this.desctiptionFilter(mediaItems, filter);
      if (mediaItems?.length && filter.space) mediaItems = this.spaceFilter(mediaItems, filter);
      if (mediaItems?.length && filter.quality) mediaItems = this.qualityFilter(mediaItems, filter);
      if (mediaItems?.length && (filter.lowerBoundarySize || filter.higherBoundarySize)) mediaItems = this.sizeFilter(mediaItems, filter);
    }
    return mediaItems;
  }

  async extendMediaItemsWithMediaInfo(mediaItems) {
    const mediaInfoData = await this.apiUtils.getBatchMediaInfoChunked(mediaItems);

    const extendedMediaItems = mediaItems.map((item) => {
      const matchingInfoItem = mediaInfoData.find((infoItem) => infoItem.mediaKey === item.mediaKey);
      return { ...item, ...matchingInfoItem };
    });
    return extendedMediaItems;
  }

  async getLibraryItemsByTakenDate(filter) {
    let source;
    if (filter.archived === 'true') {
      source = 'archive';
    } else if (filter.archived === 'false') {
      source = 'library';
    }

    let lowerBoundaryDate = new Date(filter.lowerBoundaryDate).getTime();
    let higherBoundaryDate = new Date(filter.higherBoundaryDate).getTime();

    lowerBoundaryDate = isNaN(lowerBoundaryDate) ? -Infinity : lowerBoundaryDate;
    higherBoundaryDate = isNaN(higherBoundaryDate) ? Infinity : higherBoundaryDate;

    const mediaItems = [];

    let nextPageId = null;

    if (Number.isInteger(lowerBoundaryDate || Number.isInteger(higherBoundaryDate)) && filter.intervalType === 'include') {
      let nextPageTimestamp = higherBoundaryDate !== Infinity ? higherBoundaryDate : null;
      do {
        if (!this.isProcessRunning) return;
        let mediaPage = await this.api.getItemsByTakenDate(nextPageTimestamp, source, nextPageId);
        nextPageId = mediaPage?.nextPageId;
        if (!mediaPage) break;
        nextPageTimestamp = mediaPage.lastItemTimestamp - 1;
        mediaPage.items = mediaPage.items.filter((item) => item.timestamp >= lowerBoundaryDate && item.timestamp <= higherBoundaryDate);
        if (!mediaPage.items || mediaPage?.items?.length === 0) continue;
        log(`Found ${mediaPage?.items?.length} items`);
        mediaItems.push(...mediaPage.items);
      } while ((nextPageId && !nextPageTimestamp) || (nextPageTimestamp && nextPageTimestamp > lowerBoundaryDate));
    } else if (Number.isInteger(lowerBoundaryDate || Number.isInteger(higherBoundaryDate)) && filter.intervalType === 'exclude') {
      let nextPageTimestamp = null;
      do {
        if (!this.isProcessRunning) return;
        let mediaPage = await this.api.getItemsByTakenDate(nextPageTimestamp, source, nextPageId);
        nextPageId = mediaPage?.nextPageId;
        if (!mediaPage) break;
        nextPageTimestamp = mediaPage.lastItemTimestamp - 1;
        mediaPage.items = mediaPage.items.filter((item) => item.timestamp < lowerBoundaryDate || item.timestamp > higherBoundaryDate);

        if (nextPageTimestamp > lowerBoundaryDate && nextPageTimestamp < higherBoundaryDate) {
          nextPageTimestamp = lowerBoundaryDate;
        } else {
          nextPageTimestamp = mediaPage.lastItemTimestamp - 1;
        }

        if (!mediaPage.items || mediaPage?.items?.length === 0) continue;

        log(`Found ${mediaPage?.items?.length} items`);
        mediaItems.push(...mediaPage.items);
      } while (nextPageId);
    } else {
      let nextPageTimestamp = null;
      do {
        if (!this.isProcessRunning) return;
        let mediaPage = await this.api.getItemsByTakenDate(nextPageTimestamp, source, nextPageId);
        nextPageId = mediaPage?.nextPageId;
        if (!mediaPage) break;
        nextPageTimestamp = mediaPage.lastItemTimestamp - 1;
        if (!mediaPage.items || mediaPage?.items?.length === 0) continue;
        log(`Found ${mediaPage?.items?.length} items`);
        mediaItems.push(...mediaPage.items);
      } while (nextPageId);
    }

    return mediaItems;
  }

  async getLibraryItemsByUploadDate(filter) {
    let lowerBoundaryDate = new Date(filter.lowerBoundaryDate).getTime();
    let higherBoundaryDate = new Date(filter.higherBoundaryDate).getTime();

    lowerBoundaryDate = isNaN(lowerBoundaryDate) ? -Infinity : lowerBoundaryDate;
    higherBoundaryDate = isNaN(higherBoundaryDate) ? Infinity : higherBoundaryDate;

    const mediaItems = [];

    let nextPageId = null;

    let skipTheRest = false;

    do {
      if (!this.isProcessRunning) return;
      let mediaPage = await this.api.getItemsByUploadedDate(nextPageId);
      const lastTimeStamp = mediaPage.items.at(-1).creationTimestamp;
      nextPageId = mediaPage?.nextPageId;
      if (!mediaPage) break;
      if (filter.intervalType === 'include') {
        mediaPage.items = mediaPage.items.filter(
          (item) => item.creationTimestamp >= lowerBoundaryDate && item.creationTimestamp <= higherBoundaryDate
        );
        skipTheRest = lastTimeStamp < lowerBoundaryDate;
      } else if (filter.intervalType === 'exclude') {
        mediaPage.items = mediaPage.items.filter((item) => item.creationTimestamp < lowerBoundaryDate || item.creationTimestamp > higherBoundaryDate);
      }
      if (!mediaPage.items || mediaPage?.items?.length === 0) continue;
      log(`Found ${mediaPage?.items?.length} items`);
      mediaItems.push(...mediaPage.items);
    } while (nextPageId && !skipTheRest);

    return mediaItems;
  }

  fileNameFilter(mediaItems, filter) {
    log('Filtering by filename');
    const regex = new RegExp(filter.fileNameRegex);
    if (filter?.fileNameMatchType === 'include') mediaItems = mediaItems.filter((item) => regex.test(item.fileName));
    else if (filter?.fileNameMatchType === 'exclude') mediaItems = mediaItems.filter((item) => !regex.test(item.fileName));
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  desctiptionFilter(mediaItems, filter) {
    log('Filtering by description');
    const regex = new RegExp(filter.descriptionRegex);
    if (filter?.descriptionMatchType === 'include') mediaItems = mediaItems.filter((item) => regex.test(item.descriptionFull));
    else if (filter?.descriptionMatchType === 'exclude') mediaItems = mediaItems.filter((item) => !regex.test(item.descriptionFull));
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  sizeFilter(mediaItems, filter) {
    log('Filtering by size');
    if (parseInt(filter?.higherBoundarySize) > 0) mediaItems = mediaItems.filter((item) => item.size < filter.higherBoundarySize);
    if (parseInt(filter?.lowerBoundarySize) > 0) mediaItems = mediaItems.filter((item) => item.size > filter.lowerBoundarySize);
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  qualityFilter(mediaItems, filter) {
    log('Filtering by quality');
    if (filter.quality == 'original') mediaItems = mediaItems.filter((item) => item.isOriginalQuality);
    else if (filter.quality == 'storage-saver') mediaItems = mediaItems.filter((item) => !item.isOriginalQuality);
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  spaceFilter(mediaItems, filter) {
    log('Filtering by space');
    if (filter.space === 'consuming') mediaItems = mediaItems.filter((item) => item.takesUpSpace);
    else if (filter.space === 'non-consuming') mediaItems = mediaItems.filter((item) => !item.takesUpSpace);
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterByDate(mediaItems, filter) {
    log('Filtering by date');
    let lowerBoundaryDate = new Date(filter.lowerBoundaryDate).getTime();
    let higherBoundaryDate = new Date(filter.higherBoundaryDate).getTime();

    lowerBoundaryDate = isNaN(lowerBoundaryDate) ? -Infinity : lowerBoundaryDate;
    higherBoundaryDate = isNaN(higherBoundaryDate) ? Infinity : higherBoundaryDate;

    if (filter.intervalType === 'include') {
      if (filter.dateType === 'taken') {
        mediaItems = mediaItems.filter((item) => item.timestamp >= lowerBoundaryDate && item.timestamp <= higherBoundaryDate);
      } else if (filter.dateType === 'uploaded') {
        mediaItems = mediaItems.filter((item) => item.creationTimestamp >= lowerBoundaryDate && item.creationTimestamp <= higherBoundaryDate);
      }
    } else if (filter.intervalType === 'exclude') {
      if (filter.dateType === 'taken') {
        mediaItems = mediaItems.filter((item) => item.timestamp < lowerBoundaryDate || item.timestamp > higherBoundaryDate);
      } else if (filter.dateType === 'uploaded') {
        mediaItems = mediaItems.filter((item) => item.creationTimestamp < lowerBoundaryDate || item.creationTimestamp > higherBoundaryDate);
      }
    }
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterByMediaType(mediaItems, filter) {
    // if has duration - video, else image
    log('Filtering by media type');
    if (filter.type === 'video') mediaItems = mediaItems.filter((item) => item.duration);
    else if (filter.type === 'image') mediaItems = mediaItems.filter((item) => !item.duration);
    else if (filter.type === 'live') mediaItems = mediaItems.filter((item) => item.isLivePhoto);
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterFavorite(mediaItems, filter) {
    log('Filtering favorites');
    if (filter.favorite === 'true') {
      mediaItems = mediaItems.filter((item) => item?.isFavorite !== false);
    } else if (filter.favorite === 'false' || filter.excludeFavorites) {
      mediaItems = mediaItems.filter((item) => item?.isFavorite !== true);
    }

    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterOwned(mediaItems, filter) {
    log('Filtering owned');
    if (filter.owned === 'true') {
      mediaItems = mediaItems.filter((item) => item?.isOwned !== false);
    } else if (filter.owned === 'false') {
      mediaItems = mediaItems.filter((item) => item?.isOwned !== true);
    }
    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterByUploadStatus(mediaItems, filter) {
    log('Filtering by upload status');
    if (filter.uploadStatus === 'full') {
      mediaItems = mediaItems.filter((item) => item?.isPartialUpload === false);
    } else if (filter.uploadStatus === 'partial') {
      mediaItems = mediaItems.filter((item) => item?.isPartialUpload === true);
    }

    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  filterArchived(mediaItems, filter) {
    log('Filtering archived');
    if (filter.archived === 'true') {
      mediaItems = mediaItems.filter((item) => item?.isArchived !== false);
    } else if (filter.archived === 'false') {
      mediaItems = mediaItems.filter((item) => item?.isArchived !== true);
    }

    log(`Item count after filtering: ${mediaItems?.length}`);
    return mediaItems;
  }

  preChecks(filter) {
    if (filter.fileNameRegex) {
      const isValid = isPatternValid(filter.fileNameRegex);
      if (isValid !== true) throw new Error(isValid);
    }
    if (filter.descriptionRegex) {
      const isValid = isPatternValid(filter.descriptionRegex);
      if (isValid !== true) throw new Error(isValid);
    }
    if (parseInt(filter.lowerBoundarySize) >= parseInt(filter.higherBoundarySize)) {
      throw new Error('Invalid Size Filter');
    }
  }

  async actionWithFilter(action, filter, source, targetAlbum, newTargetAlbumName, apiSettings) {
    try {
      this.preChecks(filter);
    } catch (error) {
      log(error, 'error');
      return;
    }

    this.isProcessRunning = true;

    // dispatching event to upate the ui without importing it
    document.dispatchEvent(new Event('change'));

    this.apiUtils = new ApiUtils(this, apiSettings || apiSettingsDefault);

    try {
      const startTime = new Date();
      const mediaItems = await this.getAndFilterMedia(filter, source, apiSettings);
      if (!mediaItems?.length) log('No items to process.');
      else {
        log(`Items to process: ${mediaItems?.length}`);
        if (action.elementId === 'restoreTrash' || source === 'trash') await this.apiUtils.restoreFromTrash(mediaItems);
        if (action.elementId === 'unLock' || source === 'lockedFolder') await this.apiUtils.removeFromLockedFolder(mediaItems);
        if (action.elementId === 'lock') await this.apiUtils.moveToLockedFolder(mediaItems);
        if (action.elementId === 'toExistingAlbum') await this.apiUtils.addToExistingAlbum(mediaItems, targetAlbum);
        if (action.elementId === 'toNewAlbum') await this.apiUtils.addToNewAlbum(mediaItems, newTargetAlbumName);
        if (action.elementId === 'toTrash') await this.apiUtils.moveToTrash(mediaItems);
        if (action.elementId === 'toArchive') await this.apiUtils.sendToArchive(mediaItems);
        if (action.elementId === 'unArchive') await this.apiUtils.unArchive(mediaItems);
        if (action.elementId === 'toFavorite') await this.apiUtils.setAsFavorite(mediaItems);
        if (action.elementId === 'unFavorite') await this.apiUtils.unFavorite(mediaItems);
        log(`Task completed in ${timeToHHMMSS(new Date() - startTime)}`, 'success');
      }
    } catch (error) {
      log(error.stack, 'error');
    }
    this.isProcessRunning = false;
  }
}
