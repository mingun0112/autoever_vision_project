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
