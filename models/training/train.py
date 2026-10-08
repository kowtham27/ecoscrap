from ultralytics import YOLO

if __name__ == '__main__':  # required on Windows for dataloader workers
    model = YOLO(r'C:\yx\yolo11s-cls.pt')
    model.train(
        data=r'C:\yx\data\ds', imgsz=224, epochs=50, patience=12, batch=48,
        device=0, workers=2, project=r'C:\yx\runs', name='escrap2', exist_ok=True,
        lr0=0.002, optimizer='AdamW', cos_lr=True,
        # photos are taken in all orientations / lighting
        fliplr=0.5, flipud=0.1, degrees=15, hsv_v=0.4, erasing=0.3,
        plots=False, verbose=True, amp=False,
    )
