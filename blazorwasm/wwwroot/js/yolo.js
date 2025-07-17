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



// 색상 정의 (Python 코드의 colors 배열과 유사하게)
//const MAX_CLASSES = 80;
//const CLASS_NAMES = [
//    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
//    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
//    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
//    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
//    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
//    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
//    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
//    'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop',
//    'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
//    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
//];
const MAX_CLASSES = 4;
const CLASS_NAMES = [
    '10원', '100원', '50원', '500원'
];
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

// NMS (Non-Maximum Suppression) 함수
function nms(boxes, scores, score_threshold, nms_threshold) {
    if (boxes.length === 0) return [];

    const rects = boxes.map(box => {
        // NMS 함수는 (x1, y1, x2, y2) 형식을 기대하므로 변환
        const x1 = box.cx - box.w / 2;
        const y1 = box.cy - box.h / 2;
        const x2 = box.cx + box.w / 2;
        const y2 = box.cy + box.h / 2;
        return [x1, y1, x2, y2];
    });

    const sortedIndices = scores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => b.score - a.score)
        .map(item => item.index);

    const keep = [];
    const suppressed = new Set();

    for (let i = 0; i < sortedIndices.length; i++) {
        const currentIdx = sortedIndices[i];
        if (suppressed.has(currentIdx)) {
            continue;
        }

        keep.push(currentIdx);
        const currentRect = rects[currentIdx];

        for (let j = i + 1; j < sortedIndices.length; j++) {
            const nextIdx = sortedIndices[j];
            if (suppressed.has(nextIdx)) {
                continue;
            }

            const nextRect = rects[nextIdx];

            const x_intersect_min = Math.max(currentRect[0], nextRect[0]);
            const y_intersect_min = Math.max(currentRect[1], nextRect[1]);
            const x_intersect_max = Math.min(currentRect[2], nextRect[2]);
            const y_intersect_max = Math.min(currentRect[3], nextRect[3]);

            const intersect_width = Math.max(0, x_intersect_max - x_intersect_min);
            const intersect_height = Math.max(0, y_intersect_max - y_intersect_min);
            const intersect_area = intersect_width * intersect_height;

            const current_area = (currentRect[2] - currentRect[0]) * (currentRect[3] - currentRect[1]);
            const next_area = (nextRect[2] - nextRect[0]) * (nextRect[3] - nextRect[1]);

            const union_area = current_area + next_area - intersect_area;
            if (union_area === 0) continue;

            const iou = intersect_area / union_area;

            if (iou > nms_threshold) {
                suppressed.add(nextIdx);
            }
        }
    }
    return keep;
}

window.initYolo = async function (modelPath = 'model/woo.onnx', videoId = 'videoFeed', canvasId = 'outputCanvas') {
    try {
        // ONNX Runtime 세션 초기화
        session = await ort.InferenceSession.create(modelPath);
        console.log("YOLO model initialized.");

        // DOM 요소 참조
        videoElement = document.getElementById(videoId);
        outputCanvas = document.getElementById(canvasId);

        if (!videoElement) {
            console.error("Video element not found with ID:", videoId);
            return;
        }
        if (!outputCanvas) {
            // 캔버스가 없으면 동적으로 생성 (권장: HTML에 직접 추가)
            outputCanvas = document.createElement('canvas');
            outputCanvas.id = canvasId;
            // 비디오 엘리먼트 바로 뒤에 추가 (위치와 크기 설정을 위해)
            videoElement.parentNode.insertBefore(outputCanvas, videoElement.nextSibling);
            console.warn(`Canvas with ID '${canvasId}' not found. Creating dynamically. Consider adding it to your HTML.`);
        }
        outputCtx = outputCanvas.getContext('2d');

        // 캔버스 크기를 비디오 엘리먼트와 동일하게 설정하여 오버레이 가능하도록 준비
        // 비디오의 실제 크기가 로드될 때까지 기다릴 수 있도록 event listener 사용
        videoElement.onloadedmetadata = () => {
            // 캔버스의 내부 그리기 표면을 비디오의 *표시된* 크기와 일치시킵니다.
            outputCanvas.width = videoElement.offsetWidth;
            outputCanvas.height = videoElement.offsetHeight;

            // 캔버스를 비디오 위에 직접 배치합니다.
            outputCanvas.style.position = 'absolute';
            outputCanvas.style.left = videoElement.offsetLeft + 'px';
            outputCanvas.style.top = videoElement.offsetTop + 'px';
            outputCanvas.style.width = videoElement.offsetWidth + 'px';
            outputCanvas.style.height = videoElement.offsetHeight + 'px';
            console.log(`Canvas drawing surface set to ${outputCanvas.width}x${outputCanvas.height} and positioned.`);
        };


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

    // 이미 감지 인터벌이 실행 중이면 중지
    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInterval = null;
        console.log("Stopped continuous YOLO detection.");
        // 감지 중지 후 캔버스 초기화
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        return; // 중지 요청이면 여기서 함수 종료
    }

    // 모델 입력 크기 (YOLOv8n/YOLO11n 기준)
    const model_input_width = 640;
    const model_input_height = 640;

    // 실시간 감지를 위한 인터벌 시작
    detectionInterval = setInterval(async () => {
        const original_video_width = videoElement.videoWidth;
        const original_video_height = videoElement.videoHeight;

        // Python 코드와 유사하게 패딩 계산 및 적용
        const length = Math.max(original_video_width, original_video_height);
        const scale = model_input_width / length; // 모델 입력 크기에 맞추기 위한 스케일 (Python의 1/length와 유사)

        const resized_width = Math.round(original_video_width * scale);
        const resized_height = Math.round(original_video_height * scale);

        const pad_x = (model_input_width - resized_width) / 2;
        const pad_y = (model_input_height - resized_height) / 2;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = model_input_width;
        tempCanvas.height = model_input_height;
        const tempCtx = tempCanvas.getContext('2d');

        // 패딩을 위한 검은색 배경 채우기
        tempCtx.fillStyle = 'black';
        tempCtx.fillRect(0, 0, model_input_width, model_input_height);

        // 원본 비디오 프레임을 종횡비 유지하여 패딩된 캔버스에 그리기
        tempCtx.drawImage(
            videoElement,
            0, 0, original_video_width, original_video_height, // Source rectangle (원본 비디오)
            pad_x, pad_y, resized_width, resized_height        // Destination rectangle (패딩된 캔버스)
        );
        const imageData = tempCtx.getImageData(0, 0, model_input_width, model_input_height);

        // 전처리
        const inputTensor = new ort.Tensor('float32', preprocess(imageData), [1, 3, model_input_height, model_input_width]);
        const feeds = { 'images': inputTensor }; // 모델의 입력 이름이 'images'라고 가정

        try {
            const results = await session.run(feeds);
            // postprocess 함수에 패딩 정보 전달
            postprocess(results, original_video_width, original_video_height, model_input_width, model_input_height, length, scale, pad_x, pad_y);
        } catch (err) {
            console.error("Error running YOLO model:", err);
            // 오류 발생 시 인터벌 중지 (선택 사항)
            clearInterval(detectionInterval);
            detectionInterval = null;
        }
    }, 150); // 100ms마다 감지 (초당 10프레임)
    console.log("Started continuous YOLO detection.");
};

function preprocess(imageData) {
    const { data, width, height } = imageData;
    const input = new Float32Array(width * height * 3); // RGB 순서 (NCHW)

    let pixelIndex = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4; // RGBA 데이터의 픽셀 시작
            // R, G, B 채널을 각각의 평면으로 분리하고 0-1 범위로 정규화
            input[pixelIndex] = data[i] / 255.0; // R
            input[pixelIndex + width * height] = data[i + 1] / 255.0; // G
            input[pixelIndex + 2 * width * height] = data[i + 2] / 255.0; // B
            pixelIndex++;
        }
    }
    return input;
}

function postprocess(results, original_width, original_height, model_input_width, model_input_height, padded_length, scale_factor_for_model_input, pad_x_offset, pad_y_offset) {
    const output = results['output0']; // 모델 출력 텐서
    const data = output.data; // Float32Array (Flattened array)
    const output_dims = output.dims; // 예를 들어, [1, 84, 8400]

    coinCounts["10"] = 0;
    coinCounts["50"] = 0;
    coinCounts["100"] = 0;
    coinCounts["500"] = 0;

    // Python 코드의 transpose와 squeeze에 해당하는 작업 수행
    // [1, 84, 8400] -> [8400, 84] 형태로 데이터를 다시 구성 (논리적 재구성)
    const num_features = output_dims[1]; // 84
    const num_predictions = output_dims[2]; // 8400

    const detectedBoxes = [];
    const CONFIDENCE_THRESHOLD = 0.25;
    const NMS_IOU_THRESHOLD = 0.45;

    for (let i = 0; i < num_predictions; i++) { // 각 예측(박스)에 대해 반복 (총 8400번)
        // ONNX Runtime JS 출력 텐서는 보통 C, H, W 순서로 데이터를 평탄화합니다.
        // 즉, Cx_all, Cy_all, W_all, H_all, Obj_all, Class0_all, ...
        // 특정 예측 i에 대한 각 값은 해당 채널의 i번째 인덱스에 있습니다.

        // 각 채널의 시작 인덱스 계산 (데이터가 채널별로 연속되어 있다고 가정)
        // C1 C2 C3 ... C8400 | C1 C2 C3 ... C8400 | ...
        const cx = data[i]; // i번째 박스의 cx
        const cy = data[i + num_predictions]; // i번째 박스의 cy
        const w = data[i + num_predictions * 2]; // i번째 박스의 w
        const h = data[i + num_predictions * 3]; // i번째 박스의 h

        const objectness = data[i + num_predictions * 4]; // i번째 박스의 objectness

        let maxClassProb = 0;
        let classId = -1;

        // 클래스 점수는 num_predictions * 5 부터 시작
        for (let c_idx = 0; c_idx < num_features - 5; c_idx++) { // num_features - 5 = 80개 클래스
            const prob = data[i + num_predictions * (5 + c_idx)];
            if (prob > maxClassProb) {
                maxClassProb = prob;
                classId = c_idx; // 0-79
                if (classId >= MAX_CLASSES) {
                    //console.warn(`Class ID ${classId} exceeds MAX_CLASSES (${MAX_CLASSES}). Skipping.`);
                    classId = 3; // 유효하지 않은 클래스 ID로 설정 (당신이 설정한 MAX_CLASSES보다 큰 경우 처리)
                }
            }
        }

        const confidence_val = Math.max(objectness, maxClassProb);

        if (confidence_val >= CONFIDENCE_THRESHOLD) {
            detectedBoxes.push({
                cx, cy, w, h, confidence: confidence_val, classId,
                score: confidence_val
            });
        }
    }

    // NMS 적용
    const scoresForNMS = detectedBoxes.map(box => box.score);
    const indicesToKeep = nms(detectedBoxes, scoresForNMS, CONFIDENCE_THRESHOLD, NMS_IOU_THRESHOLD);

    // 캔버스 초기화 (이전 프레임의 박스 제거)
    outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

    const inverse_scale = 1 / scale_factor_for_model_input;

    // --- 여기부터가 핵심 변경 사항입니다. ---
    // 캔버스의 현재 *표시된* 치수를 가져옵니다.
    // videoElement.offsetWidth/offsetHeight를 사용해도 되지만,
    // canvas의 width/height가 이미 videoElement.offsetWidth/offsetHeight로 설정되어 있어야 합니다.
    const display_width = outputCanvas.width;
    const display_height = outputCanvas.height;

    // 원본 비디오 해상도에서 캔버스 표시 해상도로의 스케일링 팩터 계산
    const scale_x_to_display = display_width / original_width;
    const scale_y_to_display = display_height / original_height;
    // --- 핵심 변경 사항 끝 ---


    // NMS를 통과한 박스 그리기
    for (const idx of indicesToKeep) {
        const box = detectedBoxes[idx];
        const classId = box.classId;
        const confidence = box.confidence;

        // 모델 출력 (cx, cy, w, h)는 640x640 패딩 이미지 기준입니다.
        // 먼저 640x640 패딩 이미지 기준의 x1, y1, x2, y2를 계산
        let x_model_padded = box.cx - box.w / 2;
        let y_model_padded = box.cy - box.h / 2;
        let w_model = box.w;
        let h_model = box.h;

        // 640x640 패딩 이미지 좌표를 원본 (패딩 제거 전) 스케일로 역변환
        // 패딩 오프셋을 빼고, `inverse_scale`을 곱하여 원본 픽셀 크기로 되돌립니다.
        const x1_original_scale = (x_model_padded - pad_x_offset) * inverse_scale;
        const y1_original_scale = (y_model_padded - pad_y_offset) * inverse_scale;
        const w_original_scale = w_model * inverse_scale;
        const h_original_scale = h_model * inverse_scale;

        // --- 여기부터가 핵심 변경 사항입니다. ---
        // 원본 비디오 크기 기준의 좌표를 캔버스 표시 크기에 맞게 최종 스케일링
        const draw_x_display = x1_original_scale * scale_x_to_display;
        const draw_y_display = y1_original_scale * scale_y_to_display;
        const draw_w_display = w_original_scale * scale_x_to_display;
        const draw_h_display = h_original_scale * scale_y_to_display;

        // 클리핑 (박스가 캔버스 경계를 벗어나지 않도록)
        const final_draw_x = Math.max(0, draw_x_display);
        const final_draw_y = Math.max(0, draw_y_display);
        const final_draw_w = Math.min(display_width - final_draw_x, draw_w_display);
        const final_draw_h = Math.min(display_height - final_draw_y, draw_h_display);
        // --- 핵심 변경 사항 끝 ---

        const color = colors[classId % MAX_CLASSES];
        outputCtx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        outputCtx.lineWidth = 5;
        outputCtx.strokeRect(final_draw_x, final_draw_y, final_draw_w, final_draw_h);

        outputCtx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        outputCtx.font = '14px Arial'; // 글꼴 크기도 display_height에 비례하여 조정하면 더 좋을 수 있습니다.
        const className = CLASS_NAMES[classId] || `Unknown Class ${classId}`;
        const label = `${className} (${confidence.toFixed(2)})`;
        outputCtx.fillText(label, final_draw_x + 5, final_draw_y - 10);

        if (classId == 0) coinCounts["10"]++;
        else if (classId == 1) coinCounts["100"]++;
        else if (classId == 2) coinCounts["50"]++;
        else if (classId == 3) coinCounts["500"]++;
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