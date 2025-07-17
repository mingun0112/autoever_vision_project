window.startVideo = async function (videoId) {
    const video = document.getElementById(videoId);
    if (!video) {
        console.error("Video element not found:", videoId);
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: "environment" } // 후면 카메라 요청
            }
        });
        video.srcObject = stream;
        video.play();
    } catch (err) {
        console.warn("Rear camera not available. Falling back to default camera.", err);
        try {
            // 후면 카메라 실패 시 기본 카메라
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true });
            video.srcObject = fallbackStream;
            video.play();
        } catch (fallbackErr) {
            console.error("Error accessing any camera:", fallbackErr);
        }
    }
};


let session;
let videoElement; // 비디오 엘리먼트 참조
let outputCanvas; // 경계 상자를 그릴 캔버스 엘리먼트
let outputCtx;    // 캔버스 2D 컨텍스트
let detectionInterval; // 실시간 감지를 위한 setInterval ID

// --- 수정 필요 1: CLASS_NAMES 순서 조정 ---
// ONNX 모델의 metadata_props.names: {0: '10-', 1: '100-', 2: '50-', 3: '500-'} 에 맞춰야 합니다.
const MAX_CLASSES = 4;
const CLASS_NAMES = [
    '10원',  // ID 0
    '100원', // ID 1
    '50원',  // ID 2
    '500원'  // ID 3
];
// 현재 당신의 코드와 ONNX metadata_props.names의 순서가 '100원'과 '50원'에서 다릅니다.
// 이 부분을 일치시키거나, metadata_props에 맞게 CLASS_NAMES를 수정해야 합니다.
// 예를 들어, ONNX metadata_props에 완벽히 일치시키려면:
// const CLASS_NAMES = [
//     '10-',
//     '100-',
//     '50-',
//     '500-'
// ];
// 혹은, 당신이 원하는 표기 방식('10원' 등)을 유지하되 순서를 맞추려면:
// const CLASS_NAMES = [
//     '10원',
//     '100원',
//     '50원',
//     '500원'
// ];
// 위와 같이 CLASS_NAMES를 이미 수정했다고 가정하고 진행합니다.


const coinCounts = {
    "10": 0,
    "50": 0,
    "100": 0,
    "500": 0
};
const colors = [];
for (let i = 0; i < MAX_CLASSES; i++) {
    colors.push([Math.random() * 255, Math.random() * 255, Math.random() * 255]);
}

// --- 수정 필요 2: NMS 함수 제거 또는 사용 안함 처리 ---
// 당신의 ONNX 모델 'best_01_include_nms.onnx'는 이름에서 알 수 있듯이 NMS가 이미 포함되어 있습니다.
// 따라서 JavaScript 단에서 별도의 NMS를 수행할 필요가 없습니다.
// 이 함수는 주석 처리하거나 삭제하는 것이 좋습니다.
/*
function nms(boxes, scores, score_threshold, nms_threshold) {
    if (boxes.length === 0) return [];
    // ... (기존 NMS 로직) ...
    return keep;
}
*/

window.initYolo = async function (modelPath = 'model/best_01_include_nms.onnx', videoId = 'videoFeed', canvasId = 'outputCanvas') { // 모델 경로 업데이트
    try {
        session = await ort.InferenceSession.create(modelPath);
        console.log("YOLO model initialized.");

        videoElement = document.getElementById(videoId);
        outputCanvas = document.getElementById(canvasId);

        if (!videoElement) {
            console.error("Video element not found with ID:", videoId);
            return;
        }
        if (!outputCanvas) {
            outputCanvas = document.createElement('canvas');
            outputCanvas.id = canvasId;
            videoElement.parentNode.insertBefore(outputCanvas, videoElement.nextSibling);
            console.warn(`Canvas with ID '${canvasId}' not found. Creating dynamically. Consider adding it to your HTML.`);
        }
        outputCtx = outputCanvas.getContext('2d');

        videoElement.onloadedmetadata = () => {
            outputCanvas.width = videoElement.offsetWidth;
            outputCanvas.height = videoElement.offsetHeight;

            outputCanvas.style.position = 'absolute';
            outputCanvas.style.left = videoElement.offsetLeft + 'px';
            outputCanvas.style.top = videoElement.offsetTop + 'px';
            outputCanvas.style.width = videoElement.offsetWidth + 'px';
            outputCanvas.style.height = videoElement.offsetHeight + 'px';
            console.log(`Canvas drawing surface set to ${outputCanvas.width}x${outputCanvas.height} and positioned.`);
        };

        // 스마트폰에서 가로/세로 전환 시에도 잘 작동하게 하려면 resize 이벤트 리스너 추가
        window.addEventListener('resize', () => {
            if (videoElement && outputCanvas) {
                outputCanvas.width = videoElement.offsetWidth;
                outputCanvas.height = videoElement.offsetHeight;
                outputCanvas.style.left = videoElement.offsetLeft + 'px';
                outputCanvas.style.top = videoElement.offsetTop + 'px';
                outputCanvas.style.width = videoElement.offsetWidth + 'px';
                outputCanvas.style.height = videoElement.offsetHeight + 'px';
                outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
            }
        });

    } catch (err) {
        console.error("Error initializing YOLO model:", err);
    }
};

window.runYolo = async function () {
    if (!session) {
        console.error("YOLO model not initialized. Call initYolo() first.");
        return;
    }
    if (!videoElement || !outputCanvas || !outputCtx || videoElement.videoWidth === 0) {
        console.error("Video not ready or initialization incomplete.");
        return;
    }

    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInterval = null;
        console.log("Stopped continuous YOLO detection.");
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        return;
    }

    const model_input_width = 640;
    const model_input_height = 640;

    detectionInterval = setInterval(async () => {
        const original_video_width = videoElement.videoWidth;
        const original_video_height = videoElement.videoHeight;

        const length = Math.max(original_video_width, original_video_height);
        const scale = model_input_width / length;

        const resized_width = Math.round(original_video_width * scale);
        const resized_height = Math.round(original_video_height * scale);

        const pad_x = (model_input_width - resized_width) / 2;
        const pad_y = (model_input_height - resized_height) / 2;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = model_input_width;
        tempCanvas.height = model_input_height;
        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.fillStyle = 'black';
        tempCtx.fillRect(0, 0, model_input_width, model_input_height);

        tempCtx.drawImage(
            videoElement,
            0, 0, original_video_width, original_video_height,
            pad_x, pad_y, resized_width, resized_height
        );
        const imageData = tempCtx.getImageData(0, 0, model_input_width, model_input_height);

        const inputTensor = new ort.Tensor('float32', preprocess(imageData), [1, 3, model_input_height, model_input_width]);
        const feeds = { 'images': inputTensor };

        try {
            const results = await session.run(feeds);
            // postprocess 함수 호출 시 더 이상 패딩 정보가 필요 없습니다.
            // 대신, 모델이 출력하는 좌표가 640x640 기준이므로, 이 정보만 전달합니다.
            // postprocess 함수 내에서 `model_input_width`, `model_input_height`를 사용할 것입니다.
            postprocess(results, original_video_width, original_video_height, model_input_width, model_input_height);
        } catch (err) {
            console.error("Error running YOLO model:", err);
            clearInterval(detectionInterval);
            detectionInterval = null;
        }
    }, 150);
    console.log("Started continuous YOLO detection.");
};

function preprocess(imageData) {
    const { data, width, height } = imageData;
    const input = new Float32Array(width * height * 3);

    let pixelIndex = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            input[pixelIndex] = data[i] / 255.0; // R
            input[pixelIndex + width * height] = data[i + 1] / 255.0; // G
            input[pixelIndex + 2 * width * height] = data[i + 2] / 255.0; // B
            pixelIndex++;
        }
    }
    return input;
}

// --- 수정 필요 3: postprocess 함수 전체 로직 변경 ---
// ONNX 출력 Shape [1, 300, 6]에 맞춰 데이터를 파싱하고 그립니다.
function postprocess(results, original_width, original_height, model_input_width, model_input_height) {
    const output = results['output0']; // 모델 출력 텐서
    const data = output.data; // Float32Array (Flattened array)
    const output_dims = output.dims; // [1, 300, 6]

    // 총 감지된 박스 수 (최대 300개)
    const num_detected_boxes = output_dims[1]; // 300
    // 각 박스당 정보 개수
    const box_info_length = output_dims[2]; // 6 (x1, y1, x2, y2, confidence, class_id)

    // 동전 카운트 초기화
    coinCounts["10"] = 0;
    coinCounts["50"] = 0;
    coinCounts["100"] = 0;
    coinCounts["500"] = 0;

    // 캔버스 초기화 (이전 프레임의 박스 제거)
    outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

    // 캔버스의 현재 *표시된* 치수를 가져옵니다.
    const display_width = outputCanvas.width;
    const display_height = outputCanvas.height;

    // 모델 입력 크기(640x640)에서 캔버스 표시 크기로 스케일링하기 위한 팩터
    // 이 모델은 이미 NMS를 포함하고 있으며, 출력 좌표는 640x640 기준으로 나옵니다.
    const scale_factor_x_from_model_to_display = display_width / model_input_width; // display_width / 640
    const scale_factor_y_from_model_to_display = display_height / model_input_height; // display_height / 640

    for (let i = 0; i < num_detected_boxes; i++) {
        // output data의 각 박스 시작 인덱스
        const offset = i * box_info_length;

        // ONNX 출력 순서: x1, y1, x2, y2, confidence, class_id
        const x1_model = data[offset];
        const y1_model = data[offset + 1];
        const x2_model = data[offset + 2];
        const y2_model = data[offset + 3];
        const confidence = data[offset + 4];
        const classId = Math.round(data[offset + 5]); // class_id는 float일 수 있으므로 반올림

        // confidence가 0이거나 매우 8낮은 박스는 유효하지 않으므로 스킵
        if (confidence <= 0.) { // CONFIDENCE_THRESHOLD 값을 직접 사용할 수도 있습니다.
            continue;
        }

        // 유효한 classId인지 확인 (0-3 범위)
        if (classId < 0 || classId >= MAX_CLASSES) {
            console.warn(`Invalid classId detected: ${classId}. Skipping box.`);
            continue;
        }

        // 캔버스에 그릴 최종 좌표 계산
        const draw_x1 = x1_model * scale_factor_x_from_model_to_display;
        const draw_y1 = y1_model * scale_factor_y_from_model_to_display;
        const draw_x2 = x2_model * scale_factor_x_from_model_to_display;
        const draw_y2 = y2_model * scale_factor_y_from_model_to_display;

        // 너비와 높이 계산
        const draw_w = draw_x2 - draw_x1;
        const draw_h = draw_y2 - draw_y1;

        // 클리핑 (박스가 캔버스 경계를 벗어나지 않도록)
        const final_draw_x = Math.max(0, draw_x1);
        const final_draw_y = Math.max(0, draw_y1);
        const final_draw_w = Math.min(display_width - final_draw_x, draw_w);
        const final_draw_h = Math.min(display_height - final_draw_y, draw_h);

        const color = colors[classId % MAX_CLASSES];
        outputCtx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        outputCtx.lineWidth = 5;
        outputCtx.strokeRect(final_draw_x, final_draw_y, final_draw_w, final_draw_h);

        outputCtx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        outputCtx.font = '14px Arial';
        const className = CLASS_NAMES[classId]; // CLASS_NAMES 배열의 순서가 ONNX metadata.names와 일치해야 합니다.
        const label = `${className} (${confidence.toFixed(2)})`;
        outputCtx.fillText(label, final_draw_x + 5, final_draw_y - 10);

        // 동전 카운트 (CLASS_NAMES 배열 순서에 맞게 정확히 매핑)
        // ONNX metadata_props.names: {0: '10-', 1: '100-', 2: '50-', 3: '500-'}
        if (classId === 0) coinCounts["10"]++;
        else if (classId === 1) coinCounts["100"]++; // ONNX ID 1은 '100-'
        else if (classId === 2) coinCounts["50"]++;  // ONNX ID 2는 '50-'
        else if (classId === 3) coinCounts["500"]++; // ONNX ID 3은 '500-'
    }

    // Update UI safely
    ["10", "50", "100", "500"].forEach(coin => {
        const el = document.getElementById(`coin-${coin}`);
        if (el) {
            el.textContent = `${coinCounts[coin]}개`;
        } else {
            console.warn(`ID coin-${coin}에 해당하는 요소가 없습니다.`);
        }
    });
    const total_amount = document.getElementById("total_amount");
    const total_coin = document.getElementById("total_coin");
    const total_coin_display = document.getElementById("total_coin_display");

    total_amount.textContent = `${coinCounts["10"] * 10 + coinCounts["50"] * 50 + coinCounts["100"] * 100 + coinCounts["500"] * 500}원`;
    total_coin.textContent = `${coinCounts["10"] + coinCounts["50"] + coinCounts["100"] + coinCounts["500"]}개`;
    total_coin_display.textContent = total_amount.textContent;
}