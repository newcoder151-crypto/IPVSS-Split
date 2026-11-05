Changed files only, in the same folder structure as IPVSS-Split-main.
Copy this folder's contents over your project (same paths), then:
  1. DELETE  control-room/RPF_CMS/rpf/src/routes/requests.js   (old single-camera route, removed)
  2. Review config/control-room.conf and train/config/train.conf (ports, hosts, TRAIN_NO, MNVR_NO)
  3. Re-run the launchers; migration 005_train_fleet.sql is applied on start.
API reference: train-footage-request-api.docx
