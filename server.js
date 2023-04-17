import express from 'express'
// import ip from 'ip'
// import PQueue from 'p-queue';
import { getCategory, getVideoUrls } from './worker.js';

// scp m3u/*.js* scp://u0_a104@192.168.86.165:8022//data/data/com.termux/files/home/m3u

// while true; do
//   /data/data/com.termux/files/usr/bin/node /data/data/com.termux/files/home/m3u/server.js > stdout.txt 2> stderr.txt
// done

const app = express()
const port = process.env.PORT || 3000

const SERVER_URL = `http://localhost:${port}`

const toM3U = (items) => {
  const converted = items.map(i => {
    const url = i.url ? i.url : `${SERVER_URL}${i.path}`
    return `#EXTINF:-1,${i.name}\n${url}\n`
  }).join('')
  return `#EXTM3U\n${converted}`
}

const getKeyFromLink = (link) => {
  const linkComponents = link.split('=')
  return linkComponents[linkComponents.length - 1]
}

const originalLog = console.log
console.log = (...args) => {
  const now = new Date()
  originalLog(`[${now.toLocaleTimeString()}]`, ...args)
}

class Cache {
  storage = {}

  setCacheItem(key, data) {
    if (data) {
      this.storage[key] = {
        date: new Date(),
        data
      }
    } else {
      delete this.storage[key]
    }
  }

  getCachedItem(key, timeout) {
    if (this.storage[key] && this.storage[key].data) {
      const cacheItem = this.storage[key]
      const now = new Date()
      if (now - cacheItem.date >= timeout) {
        delete this.storage[key]
      } else {
        return cacheItem.data
      }
    }
  }

  getCachedVideoItem(key, timeout) {
    if (this.storage[key] && this.storage[key].data) {
      const cacheItem = this.storage[key]
      const url = new URL(cacheItem.data)
      const validTo = parseInt(url.searchParams.get('validto')) * 1000
      const ttl = parseInt(url.searchParams.get('ttl')) * 1000

      const now = new Date()
      // console.log('isCached', key, now > validTo, '||', ttl > validTo, '||', now - cacheItem.date >= timeout)

      if (now > validTo
        || ttl > validTo
        || now - cacheItem.date >= timeout) {
        delete this.storage[key]
      } else {
        return cacheItem.data
      }
    }
  }
}

class List {
  cache = new Cache()
  categories = ['MOST_VIEWED', 'HOTTEST', 'TOP_RATED']
  // categories = ['HOTTEST']

  categoryCacheTime = 1
  videoCacheTime = 0.5 * 3600 * 1000

  // queue = new PQueue({ concurrency: 1 })


  refreshCache = async () => {
    console.log('')
    console.log('*** Refresh cache ***')
    for (const category of this.categories) {
      const categoryData = await this.fetchCategoryIfNeeded(category, 2, 1)
      if (!categoryData) { return }

      const firstVideo = categoryData[0]
      const key = getKeyFromLink(firstVideo.link)
      await this.fetchVideoIfNeeded(key, 1, '[REFRESH CACHE]')
    }

    setTimeout(this.refreshCache, 60 * 1000)
  }

  categoryPromises = {}
  getCategoryItems = async (category, pages, priority) => {
    const t1 = Date.now()
    console.log(`getCategoryItems API call START ${category} ${pages}`)

    if (!this.categoryPromises[category]) {
      // this.categoryPromises[category] = this.queue.add(() => getTaskWorker(createTaskCategory(category, pages)), priority)
      // this.categoryPromises[category] = getTaskWorker(createTaskCategory(category, pages))
      this.categoryPromises[category] = await getCategory(category, pages)
    }
    const videos = await this.categoryPromises[category]

    delete this.categoryPromises[category]

    const t2 = Date.now()
    console.log(`  getCategoryItems API call END ${category} ${pages} in ${t2 - t1} ms`)
    return videos.results
  }

  videoPromises = {}
  getVideoLink = async (key, source, priority) => {
    const url = `https://www.pornhub.com/view_video.php?viewkey=${key}`;
    try {
      const t1 = Date.now()
      console.log(`getVideoLink ${key} ${source} API call START`)

      if (!this.videoPromises[key]) {
        // this.videoPromises[key] = this.queue.add(() => getTaskWorker(createTaskVideo(url)), priority)
        // this.videoPromises[key] = createTaskVideo(url)

        this.videoPromises[key] = getVideoUrls(url)
      }
      const video = await this.videoPromises[key]
  
      delete this.videoPromises[key]

      const t2 = Date.now()
      console.log(`  getVideoLink ${key} ${source} API call END in ${t2 - t1} ms`)

      const { download_urls } = video

      if (!download_urls) { return }
        
      if (download_urls['480P']) { return download_urls['480P'] }
      else if (download_urls['720P']) { return download_urls['720P'] }
      else { return Object.values(download_urls)[0] }
    } catch (error) {
      console.log(`  getVideoLink ${key} ${source} API call END error ${error}`)
    }
  }

  fetchCategoryIfNeeded = async (category, pages, priority) => {
    const cachedCategory = this.cache.getCachedItem(category, this.categoryCacheTime)
    if (cachedCategory) {
      console.log('CACHED', category, cachedCategory.length)
      return cachedCategory
    } else {
      const fetchedCaregory = await this.getCategoryItems(category, pages, priority)
      this.cache.setCacheItem(category, fetchedCaregory)
      return fetchedCaregory
    }
  }

  fetchVideoIfNeeded = async (key, priority, source) => {
    const cachedVideo = this.cache.getCachedVideoItem(key, this.videoCacheTime)
    if (cachedVideo) {
      console.log('CACHED', key, cachedVideo, source)
      return cachedVideo
    } else {
      const fetchedVideoLink = await this.getVideoLink(key, source, priority)
      this.cache.setCacheItem(key, fetchedVideoLink)
      return fetchedVideoLink
    }
  }

  requestCategory = async (category, pages) => {
    return await this.fetchCategoryIfNeeded(category, pages, 10)
  }

  requestVideo = async (category, key) => {
    const video = await this.fetchVideoIfNeeded(key, 10, '[USER]')

    setImmediate(async () => {
      const cachedCategory = this.cache.getCachedItem(category, this.categoryCacheTime)
      if (!cachedCategory) {
        console.log(`${key} => [USER PRELOAD] FAILED`) 
        return
      }
      const videoIndex = cachedCategory.findIndex((video) => {
        const videoKey = getKeyFromLink(video.link)
        if (videoKey === key) { return true }
      })

      for (let i = videoIndex + 1; i < videoIndex + 1 + 3; i++) {
        const video = cachedCategory[i]
        if (video) {
          const videoKey = getKeyFromLink(video.link)
          await this.fetchVideoIfNeeded(videoKey, 1, `${key} => [USER PRELOAD][${i}] => ${videoKey}`)
        }
      }
    })

    return video
  }
}

const list = new List()

app.use((req, res, next) => {
  console.log('')
  console.log(req.method, req.url)
  next()
})

// app.get('/ph.m3u8', (req, res) => {
//   const items = [
//     {
//       name: 'MOST_VIEWED',
//       path: '/ph/category/MOST_VIEWED/page/1/index.m3u8',
//     },
//     {
//       name: 'HOTTEST',
//       path: '/ph/category/HOTTEST/page/1/index.m3u8',
//     },
//     {
//       name: 'TOP_RATED',
//       path: '/ph/category/TOP_RATED/page/1/index.m3u8',
//     },
//   ]
  
//   res.send(toM3U(items))
// })

app.get('/ph/category/:category/page/:page/index.m3u8', async (req, res) => {  
  const category = req.params.category
  const page = parseInt(req.params.page)

  const videos = await list.requestCategory(category, page)
  if (!videos) {
    res.status(404)
    res.send()
    return
  }

  const content = videos.map(v => {
    const name = v.title
    const key = getKeyFromLink(v.link)
    const path = `/ph/category/${category}/video/${key}.m3u8`
    return { name, path }
  })
  // const prev = {
  //   name: filter,
  //   url: `/ph/category/${filter}/page/${page}/index.m3u8`
  // }

  // const next = {
  //   name: 'Next page',
  //   url: `/ph/category/${filter}/page/${page + 1}/index.m3u8`
  // }

  const items = [
    ...content,
    // next,
    // prev
  ]

  const data = toM3U(items)

  res.send(data)
})

app.get('/ph/category/:category/video/:key.m3u8', async (req, res) => {
  const category = req.params.category
  const { key } = req.params

  const t1 = Date.now()
  console.log(`requestVideo ${key} START`)

  const videoUrl = await list.requestVideo(category, key)

  const t2 = Date.now()
  console.log(`  requestVideo ${key} END in ${t2 - t1} ms`)

  if (videoUrl) {
    res.redirect(videoUrl)
  } else {
    res.status(404)
    res.send()
  }
})

app.get('/health', async (req, res) => {
  res.send('OK')
})

app.listen(port, () => {
  console.log(`Listening on port ${port}`)
  // list.refreshCache()
})
