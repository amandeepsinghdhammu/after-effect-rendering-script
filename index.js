/**
 * @filename: index.js
 * @description: Script to create a API server which will accept
 * request to render after effect video and upload them to S3
 *
 * @Author: Amandeep Singh<amandeepsingh@zapbuild.com>
 * @Created: 07-08-2016
 * @Modified: 17-01-2018
 */

'use strict'

const express = require('express')
const app = express()
const Promise = require('bluebird')
const shortid = require('shortid')

const http = require('http')
const url = require('url')
const path = require('path')
const fs = require('fs-extra')
const childProcess = require('child_process')

/**
 * Settings for renderer
 * DONT FORGET TO CHANGE aebinary ACCORDING TO YOUR SYSTEM
 * On Windows might look like: 'C:\\Program Files\\Adobe\\After Effects CC\\aerender.exe'
 */
const aebinary = process.env.AE_RENDER_PATH || 'C:\\Program Files\\Adobe\\Adobe After Effects CC 2017\\Support Files\\aerender.exe'
const port = process.env.PORT || 56567
const awsBucket = 'wemaki-dev'

const AWS = require('aws-sdk') // Load the AWS SDK for Node.js

/**
 * We aren't hard-coding AWS credentials!
 * Exporting following environment variables instead:
 *
 * export AWS_ACCESS_KEY_ID='AKID'
 * export AWS_SECRET_ACCESS_KEY='SECRET'
 */

var s3 = new AWS.S3({region: 'us-east-2'})
var spawn = childProcess.spawn

app.listen(port, function () {
  console.log('Example app listening on port ' + port + '!')
})

// Configuration variables
var tmpDir = './templates' // Default temporary directory
var s3UserVideosBasePath
var localBasePath
var afTemplatePath
var afTemplateName = 'render.aepx' // Default after effect file name
var afVideoPathMov
var afVideoNameMov = 'result.mov' // Default mov file generated from default after effect output template
var afVideoPath
var afVideoName = 'demo_hd.mp4' // Default video name after rendering
var filesNotTracked = ['demo_hd.mp4', 'render_old.aepx'] // Files that must skip during downloading
var afDefaultComp = 'MAIN_COMP' // Default composition name in after effect video
var processStatus = 'rendering' //  default status for db

// Steps for rendering
// 1. Accept required parameters (video_id, user_video_id) from query string
// 2. Send pre-response to the requested server for the redering process started
// 3. Download required assets for render video from s3.
// 4. Perform rendering process using af-render bash command
// 5. Convert generated video in required format using ffmpeg
// 6. Upload video to s3 at required location
// 7. Delete data after all process
// 8. Send information back to the user after process done
// 9. Send progress update on each step

app.get('/render', function (req, res) {
  var videoId = (req.query.video_id) ? req.query.video_id : '00000000'
  var userVideoId = (req.query.user_video_id) ? req.query.user_video_id : 'CD140A6F73'
  var apiEndPoint = (req.query.api_end_point) ? req.query.api_end_point : 'http://192.168.1.18:3501/uservideos'

  var randomId = userVideoId // shortid.generate();

  s3UserVideosBasePath = 'v/' + videoId + '/u'
  localBasePath = tmpDir + '/' + randomId
  afTemplatePath = localBasePath + '/' + afTemplateName

  afVideoPathMov = localBasePath + '/' + afVideoNameMov
  afVideoPath = localBasePath + '/' + afVideoName

  // validate user data
  // 1. Accept required parameters (video_id, user_video_id) from query string
  if (videoId === undefined || userVideoId === undefined || api_end_point === undefined) {
    res.send({
      'error': {
        'code': 404,
        'message': 'Required(VideoId and userVideoId) parameters are missing.'
      },
      'data': {}
    })
  }

  sendProgress(4, userVideoId, apiEndPoint, processStatus) // Send progress to server

  console.log('Downloading assets..')

  // 3. Download required assets for render video from s3.
  downloadAllAssets(randomId).then((res) => {
    
    console.log('Downloading all assets done..')
    console.log('Rendering project..')
    
    sendProgress(32, userVideoId, apiEndPoint, processStatus) // Send progress to server
    
    return renderVideo() // 4. Perform rendering process using af-render bash command
    
  }).then((res) => {
    
    console.log('Successfully render video')
    console.log('Converting video..')
    
    sendProgress(58, userVideoId, apiEndPoint, processStatus) // Send progress to server
    
    return convertVideo() // 5. Convert generated video in required format using ffmpeg
    
  }).then((res) => {
    
    console.log('Successfully converted video..')
    console.log('Uploading to s3..')
    
    sendProgress(76, userVideoId, apiEndPoint, processStatus) // Send progress to server
    
    return uploadToS3(afVideoPath, s3UserVideosBasePath + '/' + randomId + '/' + afVideoName) // 6. Upload video to s3 at required location
    
  }).then((res) => {
    
    console.log('Successfully uploaded.')
    console.log('Deleting all files..')
    
    sendProgress(94, userVideoId, apiEndPoint, processStatus) // Send progress to server
    
    return deleteAllFiles() // 7. Delete data after all process
    
  }).then((res) => {
    
    console.log('Files deleted successfully..')
    
    sendProgress(100, userVideoId, apiEndPoint, 'completed') // Send progress to server
    
    // Finished
    
  }).catch((e) => {
    
    console.log(e)
    sendProgress(0, userVideoId, apiEndPoint, "failed") // Send progress to server
    
  })

  // 2. Send pre-response to the requested server for the redering process started
  res.json({
    'status': 'progress',
    'message': 'Video is rendering. Will send you update soon.'
  })
})

/**
 *  @function sendProgress
 *  Send progress and rendering status to server
 *
 *  @param {integer} progress
 *  @param {string} userVideoId
 *  @param {string} apiEndPoint
 *  @param {string} processStatus
 *  @return {Promise}
 */
 
function sendProgress (progress, userVideoId, apiEndPoint, processStatus) {
  let apiURL = url.parse(apiEndPoint, true)

  return new Promise((resolve, reject) => {
    var bodyString = JSON.stringify({
      progress: progress,
      user_video_id: userVideoId,
      status: processStatus
    })

    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyString.length
    }

    var options = {
      hostname: apiURL.hostname,
      port: apiURL.port,
      path: apiURL.pathname,
      method: 'PUT',
      headers: headers
    }

    const req = http.request(options, (res) => {
      // console.log("STATUS:" + res.statusCode);
      // console.log("HEADERS:" + JSON.stringify(res.headers));

      res.on('data', (chunk) => {
        // console.log("BODY:" + chunk);
        resolve(true)
      })
    })
    req.on('error', function (e) {
      // console.log('problem with request: ' + e.message);
      resolve(false)
    })
    req.write(bodyString) /// / write data to request body
    req.end()
  })
}

/**
 *  @function downloadAllAssets
 *  Prepare promises ao all files on s3 to download
 *
 *  @return {Promise}
 */
function downloadAllAssets (randomId) {
  return new Promise((resolve, reject) => {
    // Folder fetch
    var params = {
      Bucket: awsBucket,
      Delimiter: '',
      Prefix: s3UserVideosBasePath + '/' + randomId
    }

    s3.listObjects(params, function (err, data) {
      if (err) {
        console.log('Here we are in key not found')
        console.log(err)
        reject(err);
      } else {
        // successful response
        let promises = []
        data.Contents.forEach(function (obj) {
          if (obj.Size > 0) {
            if (!filesNotTracked.includes(path.basename(obj.Key))) {
              let newKey = obj.Key.replace(s3UserVideosBasePath, '')
              let dir = tmpDir + path.dirname(newKey)

              fs.ensureDirSync(dir)

              promises.push(downloadSingleAsset({
                's3_path': obj.Key,
                'local_path': dir
              }))
            }
          }
        })

        return Promise.all(promises).then(function (res) {
          resolve(true)
        })
      }
    })
  })
}

/**
 *  @function downloadAllAssets
 *  Download asset from s3
 *
 *  @param {object} file
 *  @return {Promise}
 */
function downloadSingleAsset (file) {
  var destPath = file.local_path + '/' + path.basename(file.s3_path)

  return new Promise((resolve, reject) => {
    var params = {
      Bucket: awsBucket,
      Key: file.s3_path
    }
    s3.getObject(params)
    .createReadStream()
    .pipe(fs.createWriteStream(destPath))
    .on('close', () => {
      resolve(true)
    })
    .on('error', (err) => {
      reject(err)
    })
  })
}

/**
 *  @function renderVideo
 *  Render video using after effect render script
 *
 *  @return {Promise}
 */
function renderVideo () {
  return new Promise((resolve, reject) => {
    
    // create container for data and parameters
    let aedata = []
    let params = []

    // setup parameters
    params.push('-comp', afDefaultComp)
    params.push('-project', path.resolve(__dirname, afTemplatePath)) // tmpDir + '/' + randomId + '/render.aepx');
    params.push('-output', path.resolve(__dirname, afVideoPathMov)) // resultname);

    params.push('-OMtemplate', 'QuickTime')
    params.push('-s', 0)
    // spawn process and begin rendering
    let ae = spawn(aebinary, params)

    ae.on('error', (err) => {
      return reject(new Error('Error starting aerender process, did you set up the path correctly?'))
    })
    // on data (logs)
    ae.stdout.on('data', (data) => {
      aedata.push(data.toString())
    })
    // on error (logs)
    ae.stderr.on('data', (data) => {
      aedata.push(data.toString())
    })
    // on finish (code 0 - success, other - error)
    ae.on('close', (code) => {
      return (code !== 0) ? reject(aedata.join('')) : resolve(true)
    })
  })
}

/**
 *  @function convertVideo
 *  Convert video using ffmpeg
 *
 *  @param {string} randomId
 *  @param {string} videoPath
 *  @return {Promise}
 */
function convertVideo () {
  // http://standaloneinstaller.com/blog/ffmpeg-command-list-for-video-conversion-126.html

  return new Promise((resolve, reject) => {
    let aedata = []
    let params = []
    // setup parameters
    params.push('-i', path.resolve(__dirname, afVideoPathMov))
    params.push(path.resolve(__dirname, afVideoPath))
    // spawn process and begin conversion
    let ae = spawn('ffmpeg', params)

    ae.on('error', (err) => {
      return reject(new Error('Error starting ffmpeg process, did you set up the path correctly?'))
    })
    // on data (logs)
    ae.stdout.on('data', (data) => {
      aedata.push(data.toString())
    })
    // on error (logs)
    ae.stderr.on('data', (data) => {
      aedata.push(data.toString())
    })
    // on finish (code 0 - success, other - error)
    ae.on('close', (code) => {
      return (code !== 0) ? reject(aedata.join('')) : resolve(true)
    })
  })
}

/**
 *  @function uploadToS3
 *  Upload video to s3
 *
 *  @param {string} videoPath
 *  @param {string} s3VideoPath
 *  @return {Promise}
 */

function uploadToS3 (videoPath, s3VideoPath) {
  return new Promise((resolve, reject) => {
    // Read in the file, convert it to base64, store to S3
    fs.readFile(videoPath, function (err, data) {
      if (err) { reject(err) }

      var base64data = new Buffer(data, 'binary')

      // var s3 = new AWS.S3();
      s3.putObject({
        Bucket: awsBucket,
        Key: s3VideoPath,
        Body: base64data,
        ACL: 'public-read'
      }, function (resp) {
        resolve(true)
      })
    })
  })
}

/**
 *  @function deleteAllFiles
 *  Delete files
 *
 *  @return {Promise}
 */
 
function deleteAllFiles () {
  return new Promise((resolve, reject) => {
    fs.remove(path.resolve(__dirname, localBasePath)).then(() => {
      resolve(true)
    })
    .catch(err => {
      console.error(err)
      reject(err)
    })
  })
}